import assert from "node:assert/strict";
import {
  clearCachedJarvisSession,
  JARVIS_SESSION_CACHE_KEY,
  readCachedJarvisSession,
  writeCachedJarvisSession,
} from "./jarvis-session-cache.ts";
import type { JarvisSession } from "./jarvis-api.ts";

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() {
      return rows.size;
    },
    clear() {
      rows.clear();
    },
    getItem(key: string) {
      return rows.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      rows.set(key, value);
    },
    removeItem(key: string) {
      rows.delete(key);
    },
    key() {
      return null;
    },
  };
}

const session: JarvisSession = {
  token: "tok",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sessionId: "ses_1",
  userId: "user_1",
  orgId: "org_1",
  deviceId: "dev_1",
  serverPublicKey: "pk",
};

const storage = memoryStorage();
writeCachedJarvisSession(storage, session);
assert.equal(readCachedJarvisSession(storage)?.sessionId, "ses_1");
assert.equal(readCachedJarvisSession(storage, Date.parse(session.expiresAt) - 1_000), null);
clearCachedJarvisSession(storage);
assert.equal(storage.getItem(JARVIS_SESSION_CACHE_KEY), null);
assert.equal(readCachedJarvisSession(storage), null);

console.log("jarvis-session-cache.test.ts OK");
