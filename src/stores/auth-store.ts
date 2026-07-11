import { create } from "zustand";
import { validateAuthorizationToken } from "@/lib/accounts-api";
import {
  deleteDeviceKey,
  hasDeviceKey,
  registerDeviceKey,
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
  logoutWebviews,
  readAccountsSession,
  seedAccountsSession,
} from "@/lib/native-webviews";

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

  initialize: async () => {
    const stored = await loadSession();
    if (!stored) {
      set({ isInitialized: true });
      return;
    }

    if (Date.now() > stored.expiresAt) {
      await clearSession();
      set({ isInitialized: true });
      return;
    }

    // The `_atid` is never persisted; restore only the non-secret profile for an
    // optimistic shell render. The real session token is re-minted in memory via
    // device-key silent login before any SSO fires.
    set({
      session: { ...stored, token: "" },
      isInitialized: true,
    });

    void get().remintSession();
  },

  remintSession: async () => {
    const current = get().session;
    if (!current) return;

    // Browser dev (`npm run dev`) has no device key / native jar — keep the
    // optimistic session so the shell renders; SSO simply won't work off-desktop.
    if (!isTauri()) return;

    // Without a linked device key there is no silent path — force interactive login.
    if (!(await hasDeviceKey())) {
      set({ session: null });
      return;
    }

    const result = await tryDeviceKeyLogin();
    if (result.kind === "handoff" && result.sessionToken) {
      // Device-key login is a Rust HTTP call, so nothing populated the shared jar
      // — seed the freshly minted `_atid` ourselves before any product SSO fires.
      await seedAccountsSession(TENDENCYS_BASE_URL, result.sessionToken).catch(
        () => undefined,
      );
      set({
        session: { ...current, token: result.sessionToken },
        justAuthenticated: true,
      });
      return;
    }

    // Silent re-mint failed (intermediate step, error, or missing token) — drop
    // the optimistic session and route to interactive login.
    set({ session: null });
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
    void registerDeviceKey(session.token);

    return true;
  },

  consumeJustAuthenticated: () => {
    set({ justAuthenticated: false });
  },

  logout: async () => {
    await clearSession();
    useServiceStore.getState().clearSsoInitiated();
    set({ session: null, error: null });
    // Fully remove automatic sign-in on this device: unlink the device key so
    // silent login stops, clear the shared `_atid`, and tear down webviews.
    await deleteDeviceKey();
    await clearAccountsSession(TENDENCYS_BASE_URL).catch(() => undefined);
    await logoutWebviews();
  },

  getAccount: () => get().session?.account ?? null,
  getToken: () => get().session?.token ?? null,
}));
