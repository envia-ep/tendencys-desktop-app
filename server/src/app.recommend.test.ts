import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { generateEd25519, signBytes } from "./lib/crypto.ts";
import { loadEnv } from "./lib/env.ts";
import { recipeFromDraft, rememberRecipe } from "./lib/recipes.ts";
import { JarvisStore } from "./lib/store.ts";
import type { IntegrationDraft, IntegrationRecipe } from "./lib/types.ts";
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

async function recommend(app: Awaited<ReturnType<typeof boot>>["app"], auth: Record<string, string>, product: string) {
  const res = await app.request("/api/v1/integrations/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ product }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { data: { recipe: IntegrationRecipe; source: string } };
}

function draftFor(name: string, baseUrl: string): IntegrationDraft {
  const now = new Date().toISOString();
  return {
    id: "drf_test",
    orgId: "org_acme",
    name,
    sourceType: "openapi",
    status: "REVIEW_REQUIRED",
    specHash: null,
    baseUrl,
    discoveredAuth: { kind: "bearer" },
    discoveredOperations: [],
    proposedCapabilities: [],
    validationState: null,
    questions: [],
    createdBy: "user_1",
    createdAt: now,
    updatedAt: now,
  };
}

describe("POST /api/v1/integrations/recommend", () => {
  it("returns the self-serve token recipe for gmail when the platform OAuth app is not configured", async () => {
    const { app, auth } = await boot();
    const { data } = await recommend(app, auth, "gmail");
    assert.equal(data.source, "catalog");
    assert.notEqual(data.recipe.recommendedAuth.kind, "oauth");
    const keys = data.recipe.requiredFields.map((field) => field.key);
    assert.ok(!keys.includes("clientId"));
    assert.ok(!keys.includes("clientSecret"));
    assert.ok(keys.includes("secret"));
  });

  it("returns a learned recipe once a product has been remembered", async () => {
    const { store, app, auth } = await boot();
    rememberRecipe(store, recipeFromDraft(draftFor("Acme Widgets", "https://api.acme.test"), { secret: "x" }));
    const { data } = await recommend(app, auth, "Acme Widgets");
    assert.equal(data.source, "learned");
    assert.equal(data.recipe.slug, "acme_widgets");
  });

  it("falls back to an AI recipe for an unknown product when no model is configured", async () => {
    const { app, auth } = await boot();
    const { data } = await recommend(app, auth, "Totally New Thing");
    assert.equal(data.source, "ai");
    assert.equal(data.recipe.slug, "totally_new_thing");
  });

  it("requires authentication", async () => {
    const { app } = await boot();
    const res = await app.request("/api/v1/integrations/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product: "gmail" }),
    });
    assert.equal(res.status, 401);
  });
});
