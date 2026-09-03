import type { JarvisSession } from "./jarvis-api";

export const JARVIS_SESSION_CACHE_KEY = "jarvis.session.v1";
const SKEW_MS = 60_000;

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readCachedJarvisSession(
  storage: SessionStorage,
  nowMs = Date.now(),
): JarvisSession | null {
  try {
    const raw = storage.getItem(JARVIS_SESSION_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const row = JSON.parse(raw) as JarvisSession;
    if (!row.token || !row.expiresAt || Date.parse(row.expiresAt) - SKEW_MS < nowMs) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

export function writeCachedJarvisSession(storage: SessionStorage, session: JarvisSession): void {
  storage.setItem(JARVIS_SESSION_CACHE_KEY, JSON.stringify(session));
}

export function clearCachedJarvisSession(storage: SessionStorage): void {
  storage.removeItem(JARVIS_SESSION_CACHE_KEY);
}
