import { create } from "zustand";
import { extractAccountId, validateAuthorizationToken } from "@/lib/accounts-api";
import {
  deleteDeviceKey,
  hasDeviceKey,
  registerDeviceKey,
  resetDeviceKeyLoginCache,
  tryDeviceKeyLogin,
} from "@/lib/device-keys";
import {
  clearShellAuth,
  loadShellAuth,
  removeAccountSlot,
  saveSession,
  saveShellAuth,
  type AuthSession,
  type PersistedAccountSlot,
} from "@/lib/token-store";
import {
  buildShellAuthUrl,
  buildShellLogoutUrl,
  openInBrowser,
  TENDENCYS_BASE_URL,
} from "@/lib/tendencys-auth";
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
import { setLoginStarted } from "@/lib/login-gate";

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

/** Wipe product cookies/webviews so the next identity cannot inherit sessions. */
async function wipeProductSessions(): Promise<void> {
  useServiceStore.getState().clearSsoInitiated();
  await clearAccountsSession(TENDENCYS_BASE_URL).catch(() => undefined);
  await clearSharedWebData().catch(() => undefined);
  await logoutWebviews();
}

/**
 * Open the Accounts login page for a *specific* account, forcing a fresh
 * interactive login instead of silently continuing whatever account the
 * system browser's own `_atid` cookie still points at. The `email` query
 * hint alone is not enough — Accounts' axios client auto-attaches the
 * browser's still-valid session cookie to background calls the login page
 * fires, so the backend just continues that session and returns the wrong
 * account. Clearing the cookie first (via the logout landing page) forces
 * real re-authentication for the intended email.
 *
 * ponytail: the two navigations are independent browser page loads with no
 * callback into this app, so there is no event to await — a fixed delay is
 * the only coordination available. Ceiling: on a very slow connection the
 * logout page's cookie-clearing mount hook might not have run yet when the
 * login page opens. Upgrade path: ask Accounts to support a `next` redirect
 * param on `/?logout=1` so both hops happen in one browser navigation.
 */
async function openInteractiveAccountSwitch(email: string): Promise<void> {
  try {
    await openInBrowser(buildShellLogoutUrl());
  } catch (err) {
    // Fall through to login regardless — worst case the old session wins.
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  await openInBrowser(buildShellAuthUrl("login", email));
}

type AuthState = {
  session: AuthSession | null;
  /** All remembered identities (profiles only; tokens stay on the active session). */
  accounts: PersistedAccountSlot[];
  /** Last / intended active account id (survives failed remint while list remains). */
  activeAccountId: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  /**
   * Transient (not persisted): true only right after a fresh interactive login
   * or successful account switch, when the shared Accounts `_atid` is guaranteed
   * present. Eager SSO pre-warm keys off this. Consumed once.
   */
  justAuthenticated: boolean;
  /**
   * True after cold-start remint finished (success or fail). LoginPage skips a
   * second automatic device-key attempt when remint already owned the silent path.
   */
  silentLoginAttempted: boolean;
  /** True while system-browser login was opened to add another email. */
  isAddingAccount: boolean;
  initialize: () => Promise<void>;
  /** Cold-start silent re-mint of the in-memory `_atid` via device-key login. */
  remintSession: () => Promise<void>;
  validateAndLogin: (
    token: string,
    realSessionToken?: string | null,
  ) => Promise<boolean>;
  addAccount: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  consumeJustAuthenticated: () => void;
  /** Sign out the active account (remove slot; switch to another if any). */
  logout: () => Promise<void>;
  getAccount: () => TendencysAccount | null;
  getToken: () => string | null;
};

/** Align client TTL with Accounts 7-day API token from /api/accounts/authorization. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pruneExpired(accounts: PersistedAccountSlot[]): PersistedAccountSlot[] {
  const now = Date.now();
  return accounts.filter((a) => a.expiresAt > now);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  accounts: [],
  activeAccountId: null,
  isLoading: false,
  isInitialized: false,
  error: null,
  justAuthenticated: false,
  silentLoginAttempted: false,
  isAddingAccount: false,

  initialize: async () => {
    const stored = await loadShellAuth();
    if (!stored) {
      set({
        isInitialized: true,
        silentLoginAttempted: false,
        accounts: [],
        activeAccountId: null,
      });
      return;
    }

    const accounts = pruneExpired(stored.accounts);
    if (accounts.length === 0) {
      await clearShellAuth();
      set({
        isInitialized: true,
        silentLoginAttempted: false,
        accounts: [],
        activeAccountId: null,
      });
      return;
    }

    const active =
      accounts.find((a) => a.account.id === stored.activeAccountId) ??
      accounts[accounts.length - 1];

    if (accounts.length !== stored.accounts.length) {
      await saveShellAuth({
        activeAccountId: active.account.id,
        accounts,
      });
    }

    // The `_atid` is never persisted; restore only the non-secret profile for an
    // optimistic shell render. The real session token is re-minted in memory via
    // device-key silent login before any SSO fires.
    set({
      session: {
        token: "",
        account: active.account,
        expiresAt: active.expiresAt,
      },
      accounts,
      activeAccountId: active.account.id,
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

    const accountId = current.account.id;

    // Without a linked device key there is no silent path — force interactive login.
    if (!(await hasDeviceKey(accountId))) {
      set({ session: null, silentLoginAttempted: true });
      return;
    }

    const result = await tryDeviceKeyLogin(accountId);
    if (result.kind === "handoff") {
      // Accounts returns an authorization handoff (and sometimes a session
      // token). Exchange via validateAndLogin — same path as LoginPage.
      const ok = await get().validateAndLogin(
        result.authorization,
        result.sessionToken,
      );
      if (ok) {
        set({ silentLoginAttempted: true });
        return;
      }
    }

    if (result.kind === "intermediate") {
      // Terms / phone step — open in the system browser; deep link returns the handoff.
      set({ session: null, silentLoginAttempted: true });
      try {
        await openInBrowser(result.redirectUrl);
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

    // `/api/accounts/authorization` gives us the account profile (name/email)
    // and a 7d session JWT with `id` (createToken) — usable for jar seed +
    // device-key register. Never seed the one-time handoff JWT itself.
    const result = await validateAuthorizationToken(handoffToken);

    if ("error" in result) {
      set({ isLoading: false, error: result.error, isAddingAccount: false });
      return false;
    }

    const previous = get().session;
    const isSwitchOrAdd =
      get().isAddingAccount ||
      (previous !== null && previous.account.id !== result.account.id);

    // Prefer an `_atid` already in the shared jar (in-app /login) or passed from
    // Rust; otherwise use the authorization response token (system-browser path).
    // Both are residue of a *shared* jar/handoff that can still hold a stale
    // token for a *different* account (e.g. a previous failed switch already
    // seeded it) — a candidate is only trustworthy when its own `id` claim
    // matches the account this call just resolved.
    const realAtidFromJar = await readRealAtid();
    const candidateToken = realSessionToken || realAtidFromJar;
    const candidateMatches =
      !!candidateToken && extractAccountId(candidateToken) === result.account.id;
    const sessionToken = candidateMatches ? candidateToken : result.sessionToken;

    if (!sessionToken) {
      set({
        isLoading: false,
        error: "Accounts did not return a session token. Please sign in again.",
        isAddingAccount: false,
      });
      return false;
    }

    // Clean switch into a different identity: wipe prior product/Accounts jar.
    if (isSwitchOrAdd && previous) {
      await wipeProductSessions();
    }

    // System-browser login never writes cookies into WKWebView — seed when empty.
    await ensureAtidSeeded(sessionToken);

    const session: AuthSession = {
      token: sessionToken,
      account: result.account,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    await saveSession(session);
    const auth = await loadShellAuth();

    set({
      session,
      accounts: auth?.accounts ?? [
        { account: session.account, expiresAt: session.expiresAt },
      ],
      activeAccountId: session.account.id,
      isLoading: false,
      error: null,
      justAuthenticated: true,
      isAddingAccount: false,
    });

    // Await so cold-start remint works after this interactive login.
    resetDeviceKeyLoginCache();
    await registerDeviceKey(session.token, session.account.id);

    return true;
  },

  addAccount: async () => {
    set({ isAddingAccount: true, error: null });
    setLoginStarted(false);
    try {
      await openInBrowser(buildShellAuthUrl("login"));
    } catch (error) {
      console.error("[auth] addAccount open failed:", error);
      set({ isAddingAccount: false });
    }
  },

  switchAccount: async (accountId: string) => {
    const { session, accounts } = get();
    if (session?.account.id === accountId) return;

    const slot = accounts.find((a) => a.account.id === accountId);
    if (!slot) {
      return;
    }

    resetDeviceKeyLoginCache();
    await wipeProductSessions();

    await saveShellAuth({
      activeAccountId: accountId,
      accounts,
    });

    set({
      session: {
        token: "",
        account: slot.account,
        expiresAt: slot.expiresAt,
      },
      activeAccountId: accountId,
      silentLoginAttempted: false,
      justAuthenticated: false,
      error: null,
    });

    if (!isTauri()) {
      set({
        session: {
          token: "",
          account: slot.account,
          expiresAt: slot.expiresAt,
        },
        activeAccountId: accountId,
        silentLoginAttempted: true,
      });
      return;
    }

    const deviceKeyLinked = await hasDeviceKey(accountId);
    if (!deviceKeyLinked) {
      // Keep the target as active profile; force interactive re-login.
      // Pass the target email so the browser login page targets this
      // account instead of defaulting to whichever account it already
      // remembers (its own device-account list can differ from ours).
      set({ session: null, silentLoginAttempted: true });
      setLoginStarted(false);
      try {
        await openInteractiveAccountSwitch(slot.account.email);
      } catch {
        // Welcome is the fallback.
      }
      return;
    }

    const result = await tryDeviceKeyLogin(accountId, { force: true });
    if (result.kind === "handoff") {
      // Device-key login returns an authorization handoff JWT in redirect_url;
      // sessionToken is often absent. Exchange it the same way LoginPage does.
      const ok = await get().validateAndLogin(
        result.authorization,
        result.sessionToken,
      );
      if (ok) {
        if (get().activeAccountId === accountId) {
          set({ silentLoginAttempted: true });
          return;
        }
        // The device key stored locally under `accountId` authenticated as a
        // *different* Accounts identity — the server has this device_id bound
        // to the wrong account (a historical mis-registration). Silently
        // trusting it would keep bouncing every future switch back to that
        // other identity. Purge the bad key and force a real interactive
        // login for the intended account, which re-registers a correct one.
        // Also wipe the shared jar now (it may have just been reseeded with
        // the *wrong* account's cookie by the failed validateAndLogin above)
        // and keep `activeAccountId`/`silentLoginAttempted` pointed at the
        // intended account so LoginPage doesn't race in with another silent
        // device-key attempt using a stale id while the browser flow runs.
        set({
          session: null,
          activeAccountId: accountId,
          silentLoginAttempted: true,
        });
        await wipeProductSessions();
        await deleteDeviceKey(accountId);
        resetDeviceKeyLoginCache();
        setLoginStarted(false);
        try {
          await openInteractiveAccountSwitch(slot.account.email);
        } catch {
          // Welcome fallback.
        }
        return;
      }
    }

    if (result.kind === "intermediate") {
      set({ session: null, silentLoginAttempted: true });
      setLoginStarted(false);
      try {
        await openInBrowser(result.redirectUrl);
      } catch {
        // Welcome fallback.
      }
      return;
    }

    // Remint failed — do not fall back to the previous email's jar.
    set({ session: null, silentLoginAttempted: true });
    setLoginStarted(false);
    try {
      await openInteractiveAccountSwitch(slot.account.email);
    } catch {
      // Welcome fallback.
    }
  },

  removeAccount: async (accountId: string) => {
    const { session, accounts } = get();
    const wasActive = session?.account.id === accountId;
    const remaining = accounts.filter((a) => a.account.id !== accountId);

    await deleteDeviceKey(accountId);
    const next = await removeAccountSlot(accountId);

    if (!next || remaining.length === 0) {
      resetDeviceKeyLoginCache();
      set({
        session: null,
        accounts: [],
        activeAccountId: null,
        error: null,
        silentLoginAttempted: true,
        isAddingAccount: false,
        justAuthenticated: false,
      });
      setLoginStarted(false);
      await wipeProductSessions();
      return;
    }

    set({ accounts: next.accounts, activeAccountId: next.activeAccountId });

    if (wasActive) {
      await get().switchAccount(next.activeAccountId);
    }
  },

  consumeJustAuthenticated: () => {
    set({ justAuthenticated: false });
  },

  logout: async () => {
    const activeId = get().session?.account.id;
    if (activeId) {
      await get().removeAccount(activeId);
      return;
    }

    resetDeviceKeyLoginCache();
    await clearShellAuth();
    set({
      session: null,
      accounts: [],
      activeAccountId: null,
      error: null,
      silentLoginAttempted: true,
      isAddingAccount: false,
    });
    setLoginStarted(false);
    await wipeProductSessions();
  },

  getAccount: () => get().session?.account ?? null,
  getToken: () => get().session?.token ?? null,
}));
