import { create } from "zustand";
import { validateAuthorizationToken } from "@/lib/accounts-api";
import {
  hasDeviceKey,
  registerDeviceKey,
  resetDeviceKeyLoginCache,
  tryDeviceKeyLogin,
} from "@/lib/device-keys";
import {
  clearSession,
  loadSession,
  saveSession,
  type AuthSession,
} from "@/lib/token-store";
import { TENDENCYS_BASE_URL } from "@/lib/tendencys-auth";
import { isTauri } from "@/lib/tauri";
import type { TendencysAccount } from "@/lib/accounts-api";
import { useServiceStore } from "@/stores/service-store";
import {
  clearAccountsSession,
  clearSharedWebData,
  logoutWebviews,
  readAccountsSession,
} from "@/lib/native-webviews";
import { ensureAtidSeeded } from "@/lib/atid-jar";

/**
 * The Accounts `/login` page sets the real session cookie (`_atid`: id + aud) in
 * the shared jar; committing it can lag the handoff by a beat. Poll briefly so we
 * capture that token instead of racing the WKWebView cookie store.
 */
async function readRealAtid(): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const atid = await readAccountsSession(TENDENCYS_BASE_URL).catch(() => null);
    if (atid) return atid;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

type AuthState = {
  session: AuthSession | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  /**
   * Transient (not persisted): true only right after a fresh interactive login,
   * when the shared Accounts `_atid` is guaranteed present. Eager SSO pre-warm
   * keys off this so it never fires on cold-start session restore (where `_atid`
   * may be gone and a hidden webview would land on a login form). Consumed once.
   */
  justAuthenticated: boolean;
  /**
   * True after cold-start remint finished (success or fail). LoginPage skips a
   * second automatic device-key attempt when remint already owned the silent path.
   */
  silentLoginAttempted: boolean;
  initialize: () => Promise<void>;
  /** Cold-start silent re-mint of the in-memory `_atid` via device-key login. */
  remintSession: () => Promise<void>;
  validateAndLogin: (
    token: string,
    realSessionToken?: string | null,
  ) => Promise<boolean>;
  consumeJustAuthenticated: () => void;
  logout: () => Promise<void>;
  getAccount: () => TendencysAccount | null;
  getToken: () => string | null;
};

/** Align client TTL with Accounts 7-day API token from /api/accounts/authorization. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  isLoading: false,
  isInitialized: false,
  error: null,
  justAuthenticated: false,
  silentLoginAttempted: false,

  initialize: async () => {
    const stored = await loadSession();
    if (!stored) {
      set({ isInitialized: true, silentLoginAttempted: false });
      return;
    }

    if (Date.now() > stored.expiresAt) {
      await clearSession();
      set({ isInitialized: true, silentLoginAttempted: false });
      return;
    }

    // The `_atid` is never persisted; restore only the non-secret profile for an
    // optimistic shell render. The real session token is re-minted in memory via
    // device-key silent login before any SSO fires.
    set({
      session: { ...stored, token: "" },
      isInitialized: true,
      silentLoginAttempted: false,
    });

    void get().remintSession();
  },

  remintSession: async () => {
    const current = get().session;
    if (!current) return;

    // Browser dev (`npm run dev`) has no device key / native jar — keep the
    // optimistic session so the shell renders; SSO simply won't work off-desktop.
    if (!isTauri()) {
      set({ silentLoginAttempted: true });
      return;
    }

    // Without a linked device key there is no silent path — force interactive login.
    if (!(await hasDeviceKey())) {
      set({ session: null, silentLoginAttempted: true });
      return;
    }

    const result = await tryDeviceKeyLogin();
    if (result.kind === "handoff" && result.sessionToken) {
      // Device-key login is a Rust HTTP call, so nothing populated the shared jar
      // — seed the freshly minted `_atid` ourselves before any product SSO fires.
      await ensureAtidSeeded(result.sessionToken);
      set({
        session: { ...current, token: result.sessionToken },
        justAuthenticated: true,
        silentLoginAttempted: true,
      });
      return;
    }

    if (result.kind === "intermediate") {
      // Terms / phone step — open in the system browser; deep link returns the handoff.
      set({ session: null, silentLoginAttempted: true });
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.redirectUrl);
      } catch {
        // LoginPage Welcome is the fallback if the opener fails.
      }
      return;
    }

    // Silent re-mint failed (error, unavailable, rate-limited, missing token) — drop
    // the optimistic session and route to interactive login. Mark attempted so
    // LoginPage does not immediately re-hit options+login.
    set({ session: null, silentLoginAttempted: true });
  },

  validateAndLogin: async (
    handoffToken: string,
    realSessionToken?: string | null,
  ) => {
    set({ isLoading: true, error: null });

    // `/api/accounts/authorization` gives us the account profile (name/email).
    const result = await validateAuthorizationToken(handoffToken);

    if ("error" in result) {
      set({ isLoading: false, error: result.error });
      return false;
    }

    // The session token MUST be the real Accounts `_atid` (id + aud), which the
    // `/login` page already set in the shared jar — the `/api/accounts/authorization`
    // token has no `id` and is rejected by `/api/login/sites` (silent SSO).
    // Prefer the value handed to us, then a fresh jar read; only fall back to the
    // authorization token so the shell stays usable if the jar read races.
    const sessionToken =
      realSessionToken || (await readRealAtid()) || result.sessionToken;

    const session: AuthSession = {
      token: sessionToken,
      account: result.account,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    await saveSession(session);
    set({ session, isLoading: false, error: null, justAuthenticated: true });

    // Auto-link this device for silent re-auth on next launch (non-blocking).
    // registerDeviceKey rotates the local key if Accounts reports the device_id
    // is already owned by another account (logout-kept key + different user).
    void registerDeviceKey(session.token);

    return true;
  },

  consumeJustAuthenticated: () => {
    set({ justAuthenticated: false });
  },

  logout: async () => {
    await clearSession();
    useServiceStore.getState().clearSsoInitiated();
    // Drop any cached failed silent-login result so the next sign-in starts clean.
    resetDeviceKeyLoginCache();
    set({ session: null, error: null, silentLoginAttempted: true });
    // Keep the local device key (machine trust) so a later cold launch can remint
    // without minting a new Accounts row. silentLoginAttempted=true so LoginPage
    // shows Welcome instead of instantly signing the user back in.
    await clearAccountsSession(TENDENCYS_BASE_URL).catch(() => undefined);
    // Wipe the whole shared jar (Accounts `ec_session` + product sessions), not
    // just `_atid` — otherwise the next user's `/login` auto-redirects as the
    // previous user. Must run before logoutWebviews() closes the webviews.
    await clearSharedWebData().catch(() => undefined);
    await logoutWebviews();
  },

  getAccount: () => get().session?.account ?? null,
  getToken: () => get().session?.token ?? null,
}));
