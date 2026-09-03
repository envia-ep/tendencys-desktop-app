import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { generateEd25519, signBytes } from "./lib/crypto.ts";
import { loadEnv } from "./lib/env.ts";
import { JarvisStore } from "./lib/store.ts";
import { memoryWorkforce } from "./lib/workforce.ts";

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

async function boot() {
  const store = new JarvisStore();
  const workforce = memoryWorkforce();
  const server = generateEd25519();
  const device = generateEd25519();
  const env = loadEnv({
    jwtSecret: "test-jarvis-jwt-secret-min-32-chars!!",
    serverPrivateKeyB64: server.privateKeyB64,
    serverPublicKeyB64: server.publicKeyB64,
    leaseMs: 30_000,
    modelApiKey: null,
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
    inlineWorker: false,
  });
  const app = createApp({ store, env, workforce });
  const deviceId = "dev_macbook";
  const sessionRes = await app.request("/api/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      atid: "test:user_1:org_acme",
      deviceId,
      devicePublicKey: device.publicKeyB64,
      attestation: attest(device, deviceId),
      deviceName: "MacBook",
    }),
  });
  const sessionJson = (await sessionRes.json()) as {
    success: true;
    data: { token: string };
  };
  return {
    store,
    workforce,
    app,
    auth: { Authorization: `Bearer ${sessionJson.data.token}` },
  };
}

describe("workforce HTTP", () => {
  it("assigning an agent auto-dispatches a run without a fake user message", async () => {
    const { store, app, auth } = await boot();
    const seeded = store.seedDefaultJarvis("org_acme");
    const agentPrincipal = store.ensureAgentPrincipal("org_acme", seeded.agent.id, "Jarvis");
    const created = await app.request("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        name: "Follow up with Carlos",
        description: "Call about the quote",
        assigneePrincipalId: agentPrincipal.id,
      }),
    });
    const body = (await created.json()) as {
      success: true;
      data: { task: { id: string; status: string }; runId: string; created: boolean };
    };
    assert.equal(created.status, 201);
    assert.equal(body.data.task.status, "assigned");
    assert.ok(body.data.runId);
    const run = store.getRun(body.data.runId);
    assert.equal(run?.taskId, body.data.task.id);
    assert.equal(store.messagesFor(run!.threadId).some((row) => row.content.includes("[task]")), false);

    const again = await app.request(`/api/v1/tasks/${body.data.task.id}/start`, {
      method: "POST",
      headers: auth,
    });
    const started = (await again.json()) as { data: { runId: string; created: boolean } };
    assert.equal(started.data.runId, body.data.runId);
    assert.equal(started.data.created, false);
  });

  it("inbox lists assigned work and start is idempotent", async () => {
    const { store, app, auth } = await boot();
    const seeded = store.seedDefaultJarvis("org_acme");
    const agentPrincipal = store.ensureAgentPrincipal("org_acme", seeded.agent.id, "Jarvis");
    await app.request("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "Inbox item", assigneePrincipalId: agentPrincipal.id }),
    });
    const inbox = await app.request("/api/v1/inbox", { headers: auth });
    const body = (await inbox.json()) as {
      success: true;
      data: { items: Array<{ task: { name: string }; activeRun: { status: string } | null }> };
    };
    assert.equal(inbox.status, 200);
    assert.ok(body.data.items.some((row) => row.task.name === "Inbox item"));
  });
});
