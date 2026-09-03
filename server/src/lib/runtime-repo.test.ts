import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnv } from "./env.ts";
import { applyRuntimeSnapshot, memoryRuntime, snapshotRuntime } from "./runtime-repo.ts";
import { JarvisStore } from "./store.ts";

describe("loadEnv fail-fast", () => {
  it("refuses generated signing keys when Supabase is configured", () => {
    const previous = {
      privateKey: process.env.JARVIS_SERVER_PRIVATE_KEY,
      publicKey: process.env.JARVIS_SERVER_PUBLIC_KEY,
      jwt: process.env.JARVIS_JWT_SECRET,
    };
    process.env.JARVIS_SERVER_PRIVATE_KEY = "";
    process.env.JARVIS_SERVER_PUBLIC_KEY = "";
    process.env.JARVIS_JWT_SECRET = "";
    try {
      assert.throws(
        () =>
          loadEnv({
            supabaseUrl: "https://example.supabase.co",
            supabaseServiceRoleKey: "service-role-key-min-32-characters!!",
          }),
        /JARVIS_SERVER_PRIVATE_KEY/,
      );
    } finally {
      if (previous.privateKey === undefined) {
        delete process.env.JARVIS_SERVER_PRIVATE_KEY;
      } else {
        process.env.JARVIS_SERVER_PRIVATE_KEY = previous.privateKey;
      }
      if (previous.publicKey === undefined) {
        delete process.env.JARVIS_SERVER_PUBLIC_KEY;
      } else {
        process.env.JARVIS_SERVER_PUBLIC_KEY = previous.publicKey;
      }
      if (previous.jwt === undefined) {
        delete process.env.JARVIS_JWT_SECRET;
      } else {
        process.env.JARVIS_JWT_SECRET = previous.jwt;
      }
    }
  });

  it("allows generated keys when Supabase is unset", () => {
    const env = loadEnv({
      supabaseUrl: null,
      supabaseServiceRoleKey: null,
      jwtSecret: "test-jarvis-jwt-secret-min-32-chars!!",
    });
    assert.ok(env.serverPrivateKeyB64);
    assert.ok(env.serverPublicKeyB64);
  });
});

describe("memoryRuntime", () => {
  it("reuses an unexpired session and rejects a replayed nonce", async () => {
    const store = new JarvisStore();
    const runtime = memoryRuntime(store);
    const now = new Date().toISOString();
    await runtime.upsertDevice({
      id: "dev_1",
      userId: "user_1",
      orgId: "org_1",
      publicKey: "pk",
      name: "desk",
      accountsDeviceId: null,
      createdAt: now,
      revokedAt: null,
    });
    const session = await runtime.upsertSession({
      id: "ses_1",
      userId: "user_1",
      orgId: "org_1",
      deviceId: "dev_1",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
    const reused = await runtime.findReusableSession("dev_1");
    assert.equal(reused?.id, session.id);
    assert.equal(await runtime.rememberNonce("nce_1"), true);
    assert.equal(await runtime.rememberNonce("nce_1"), false);
  });

  it("hydrates a fresh store from a runtime snapshot", async () => {
    const source = new JarvisStore();
    source.createRun({
      id: "run_1",
      orgId: "org_1",
      actorId: "user_1",
      threadId: "thr_1",
      agentId: "agt_1",
      agentVersion: "ver_1",
      sessionId: "ses_1",
      deviceId: "dev_1",
      prompt: "hello",
    });
    source.addStep("run_1", "config_switch", { fromAgentId: "a", toAgentId: "b" });
    const target = new JarvisStore();
    applyRuntimeSnapshot(target, snapshotRuntime(source));
    await memoryRuntime(target).hydrateStore(target);
    assert.equal(target.getRun("run_1")?.prompt, "hello");
    assert.equal(target.stepsFor("run_1")[0]?.type, "config_switch");
  });

  it("stores and replays idempotency keys", async () => {
    const runtime = memoryRuntime(new JarvisStore());
    await runtime.storeIdempotency("k1", "runs.create", { runId: "run_1" }, 60_000);
    const cached = await runtime.getIdempotency("k1", "runs.create");
    assert.deepEqual(cached, { runId: "run_1" });
  });
});
