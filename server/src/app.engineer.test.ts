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
  const server = generateEd25519();
  const device = generateEd25519();
  const env = loadEnv({
    jwtSecret: "test-jarvis-jwt-secret-min-32-chars!!",
    serverPrivateKeyB64: server.privateKeyB64,
    serverPublicKeyB64: server.publicKeyB64,
    leaseMs: 30_000,
    inlineWorker: false,
    modelApiKey: null,
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
  });
  const app = createApp({ store, env, workforce: memoryWorkforce() });
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
  const token = ((await sessionRes.json()) as { data: { token: string } }).data.token;
  return { store, app, auth: { Authorization: `Bearer ${token}` } };
}

const OPENAPI = JSON.stringify({
  servers: [{ url: "https://api.acme.test" }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: { "/customers": { get: { operationId: "listCustomers" } } },
});

describe("integration engineer HTTP", () => {
  it("drafts, discovers from OpenAPI, and approves into a live connector", async () => {
    const { store, app, auth } = await boot();
    const create = await app.request("/api/v1/integrations/engineer", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "Acme API" }),
    });
    assert.equal(create.status, 200);
    const draftId = ((await create.json()) as { data: { draft: { id: string } } }).data.draft.id;

    const discovered = await app.request(`/api/v1/integrations/engineer/${draftId}/source`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ type: "openapi", content: OPENAPI }),
    });
    const afterDiscover = (await discovered.json()) as {
      data: { draft: { status: string; proposedCapabilities: unknown[] } };
    };
    assert.equal(afterDiscover.data.draft.status, "REVIEW_REQUIRED");
    assert.equal(afterDiscover.data.draft.proposedCapabilities.length, 1);

    const approved = await app.request(`/api/v1/integrations/engineer/${draftId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ secret: "token_123" }),
    });
    const afterApprove = (await approved.json()) as { data: { draft: { status: string }; toolIds: string[] } };
    assert.equal(afterApprove.data.draft.status, "READY");
    assert.equal(afterApprove.data.toolIds.length, 1);
    assert.ok(store.enabledCapability("org_acme", "acme_api.customers.list"));
  });

  it("rejects another org's draft with 404", async () => {
    const { app, auth } = await boot();
    const missing = await app.request("/api/v1/integrations/engineer/drf_nope", {
      headers: { ...auth },
    });
    assert.equal(missing.status, 404);
  });
});
