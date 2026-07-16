import { isTauri } from "./tauri";
import type { TendencysAccount } from "./accounts-api";

/** Tauri plugin-store file (app data dir). Prefer this over localStorage in desktop builds. */
const STORE_FILE = "shell-session.json";
const STORE_KEY = "session";
/** Legacy key used before session hardening — cleared on load/save. */
const LEGACY_STORE_KEY = "session";
const LEGACY_LOCAL_KEY = "session";

export type AuthSession = {
  /**
   * Real Accounts session token (`_atid`: id + aud). IN-MEMORY ONLY — never
   * persisted to disk. On cold start it is re-minted via device-key silent login.
   */
  token: string;
  account: TendencysAccount;
  expiresAt: number;
};

/** One signed-in identity slot (no token on disk). */
export type PersistedAccountSlot = {
  account: TendencysAccount;
  expiresAt: number;
};

/** Multi-email shell auth persisted shape. */
export type PersistedShellAuth = {
  activeAccountId: string;
  accounts: PersistedAccountSlot[];
};

/** @deprecated singleton shape — migrated on load */
export type PersistedSession = Omit<AuthSession, "token">;

type StoredSession = PersistedSession | PersistedShellAuth;

function isShellAuth(value: StoredSession): value is PersistedShellAuth {
  return (
    typeof value === "object" &&
    value !== null &&
    "accounts" in value &&
    Array.isArray((value as PersistedShellAuth).accounts) &&
    typeof (value as PersistedShellAuth).activeAccountId === "string"
  );
}

function singletonToShellAuth(session: PersistedSession): PersistedShellAuth {
  return {
    activeAccountId: session.account.id,
    accounts: [{ account: session.account, expiresAt: session.expiresAt }],
  };
}

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILE, { autoSave: true, defaults: {} });
}

async function clearLegacyStores(): Promise<void> {
  if (isTauri()) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const legacy = await load("auth.json", { autoSave: true, defaults: {} });
      await legacy.delete(LEGACY_STORE_KEY);
      await legacy.save();
    } catch {
      // Ignore missing legacy store
    }
    return;
  }

  localStorage.removeItem(LEGACY_LOCAL_KEY);
}

export async function saveShellAuth(auth: PersistedShellAuth): Promise<void> {
  await clearLegacyStores();

  if (auth.accounts.length === 0) {
    await clearShellAuth();
    return;
  }

  if (isTauri()) {
    const store = await getStore();
    await store.set(STORE_KEY, auth);
    await store.save();
    return;
  }

  localStorage.setItem(STORE_KEY, JSON.stringify(auth));
}

/** Persist the active session into the multi-account list (upsert + set active). */
export async function saveSession(session: AuthSession): Promise<void> {
  const existing = await loadShellAuth();
  const slot: PersistedAccountSlot = {
    account: session.account,
    expiresAt: session.expiresAt,
  };
  const others =
    existing?.accounts.filter((a) => a.account.id !== session.account.id) ?? [];
  await saveShellAuth({
    activeAccountId: session.account.id,
    accounts: [...others, slot],
  });
}

export async function loadShellAuth(): Promise<PersistedShellAuth | null> {
  let raw: StoredSession | null = null;

  if (isTauri()) {
    const store = await getStore();
    raw = (await store.get<StoredSession>(STORE_KEY)) ?? null;

    if (!raw) {
      // One-time migrate from legacy auth.json if present (drop any stored token).
      try {
        const { load } = await import("@tauri-apps/plugin-store");
        const legacy = await load("auth.json", { autoSave: true, defaults: {} });
        const legacySession = await legacy.get<PersistedSession>(LEGACY_STORE_KEY);
        if (legacySession?.account?.id) {
          const migrated = singletonToShellAuth({
            account: legacySession.account,
            expiresAt: legacySession.expiresAt,
          });
          await saveShellAuth(migrated);
          await legacy.delete(LEGACY_STORE_KEY);
          await legacy.save();
          return migrated;
        }
      } catch {
        // Ignore
      }
    }
  } else {
    const local = localStorage.getItem(STORE_KEY);
    if (local) {
      try {
        raw = JSON.parse(local) as StoredSession;
      } catch {
        return null;
      }
    }
  }

  if (!raw) return null;

  if (isShellAuth(raw)) {
    if (raw.accounts.length === 0) return null;
    const active =
      raw.accounts.find((a) => a.account.id === raw.activeAccountId) ??
      raw.accounts[raw.accounts.length - 1];
    return {
      activeAccountId: active.account.id,
      accounts: raw.accounts,
    };
  }

  // Migrate singleton PersistedSession → multi-account shape.
  if (raw.account?.id) {
    const migrated = singletonToShellAuth(raw);
    await saveShellAuth(migrated);
    return migrated;
  }

  return null;
}

/** Active account slot only (compat for callers that want a single session). */
export async function loadSession(): Promise<PersistedSession | null> {
  const auth = await loadShellAuth();
  if (!auth) return null;
  const active = auth.accounts.find((a) => a.account.id === auth.activeAccountId);
  if (!active) return null;
  return { account: active.account, expiresAt: active.expiresAt };
}

export async function clearShellAuth(): Promise<void> {
  await clearLegacyStores();

  if (isTauri()) {
    const store = await getStore();
    await store.delete(STORE_KEY);
    await store.save();
    return;
  }

  localStorage.removeItem(STORE_KEY);
}

/** Remove one account; returns remaining auth or null if empty. */
export async function removeAccountSlot(
  accountId: string,
): Promise<PersistedShellAuth | null> {
  const auth = await loadShellAuth();
  if (!auth) return null;

  const accounts = auth.accounts.filter((a) => a.account.id !== accountId);
  if (accounts.length === 0) {
    await clearShellAuth();
    return null;
  }

  const activeAccountId =
    auth.activeAccountId === accountId
      ? accounts[accounts.length - 1].account.id
      : auth.activeAccountId;

  const next = { activeAccountId, accounts };
  await saveShellAuth(next);
  return next;
}

export async function clearSession(): Promise<void> {
  await clearShellAuth();
}

export type Bookmark = {
  id: string;
  label: string;
  path: string;
};

const BOOKMARKS_FILE = "bookmarks.json";

async function getBookmarksStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(BOOKMARKS_FILE, { autoSave: true, defaults: {} });
}

export async function loadBookmarks(serviceId: string): Promise<Bookmark[]> {
  const key = `bookmarks:${serviceId}`;

  if (isTauri()) {
    const store = await getBookmarksStore();
    return (await store.get<Bookmark[]>(key)) ?? [];
  }

  const raw = localStorage.getItem(key);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as Bookmark[];
  } catch {
    return [];
  }
}

export async function saveBookmarks(
  serviceId: string,
  bookmarks: Bookmark[],
): Promise<void> {
  const key = `bookmarks:${serviceId}`;

  if (isTauri()) {
    const store = await getBookmarksStore();
    await store.set(key, bookmarks);
    await store.save();
    return;
  }

  localStorage.setItem(key, JSON.stringify(bookmarks));
}

export async function loadLastPath(serviceId: string): Promise<string | null> {
  const key = `lastPath:${serviceId}`;

  if (isTauri()) {
    const store = await getBookmarksStore();
    return (await store.get<string>(key)) ?? null;
  }

  return localStorage.getItem(key);
}

export async function saveLastPath(
  serviceId: string,
  path: string,
): Promise<void> {
  const key = `lastPath:${serviceId}`;

  if (isTauri()) {
    const store = await getBookmarksStore();
    await store.set(key, path);
    await store.save();
    return;
  }

  localStorage.setItem(key, path);
}
