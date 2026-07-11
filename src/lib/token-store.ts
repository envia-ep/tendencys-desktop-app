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

/** What we actually persist: non-secret account info + expiry (no token). */
export type PersistedSession = Omit<AuthSession, "token">;

type StoredSession = PersistedSession;

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

export async function saveSession(session: AuthSession): Promise<void> {
  await clearLegacyStores();

  // Strip the secret `_atid` — only non-secret account info + expiry hit disk.
  const persisted: PersistedSession = {
    account: session.account,
    expiresAt: session.expiresAt,
  };

  if (isTauri()) {
    const store = await getStore();
    await store.set(STORE_KEY, persisted);
    await store.save();
    return;
  }

  // Browser-only fallback for `npm run dev` without Tauri.
  localStorage.setItem(STORE_KEY, JSON.stringify(persisted));
}

export async function loadSession(): Promise<PersistedSession | null> {
  if (isTauri()) {
    const store = await getStore();
    const session = await store.get<StoredSession>(STORE_KEY);
    if (session) return { account: session.account, expiresAt: session.expiresAt };

    // One-time migrate from legacy auth.json if present (drop any stored token).
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const legacy = await load("auth.json", { autoSave: true, defaults: {} });
      const legacySession = await legacy.get<StoredSession>(LEGACY_STORE_KEY);
      if (legacySession) {
        const migrated: PersistedSession = {
          account: legacySession.account,
          expiresAt: legacySession.expiresAt,
        };
        await saveSession({ ...migrated, token: "" });
        await legacy.delete(LEGACY_STORE_KEY);
        await legacy.save();
        return migrated;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredSession;
    return { account: parsed.account, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await clearLegacyStores();

  if (isTauri()) {
    const store = await getStore();
    await store.delete(STORE_KEY);
    await store.save();
    return;
  }

  localStorage.removeItem(STORE_KEY);
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
