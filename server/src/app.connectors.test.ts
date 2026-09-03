import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { webhookSignature, type LookupFn } from "./lib/connectors.ts";
import { integrationStatus } from "./lib/integrations.ts";
import { generateEd25519, signBytes } from "./lib/crypto.ts";
import { loadEnv } from "./lib/env.ts";
import { JarvisStore } from "./lib/store.ts";
import { memoryWorkforce } from "./lib/workforce.ts";
import { drainWorker } from "./worker.ts";

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

async function boot(deps: { fetch?: typeof fetch; lookup?: LookupFn } = {}) {
  const store = new JarvisStore();
  const workforce = memoryWorkforce();
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
  const app = createApp({ store, env, workforce, fetch: deps.fetch, lookup: deps.lookup });
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
  const sessionJson = (await sessionRes.json()) as { success: true; data: { token: string } };
  const auth = { Authorization: `Bearer ${sessionJson.data.token}` };
  return { store, env, app, auth, workforce };
}

function grant(store: JarvisStore, toolIds: string[]) {
  const agent = [...store.agents.values()].find((row) => row.orgId === "org_acme")!;
  const principal = store.ensureAgentPrincipal("org_acme", agent.id, agent.name);
  for (const toolId of toolIds) {
    store.upsertAccessGrant({ orgId: "org_acme", principalId: principal.id, toolId, kind: "can_use" });
  }
  store.ensureHumanPrincipal("org_acme", "sales", "Sales Manager");
}

describe("connector HTTP", () => {
  it("parks for connect and makes zero outbound HTTP when no connector exists", async () => {
    let fetches = 0;
    const { store, env, app, auth } = await boot({
      fetch: async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      },
    });
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        prompt: "look for churned customers in my store and send them a reminder and maybe check if we could give a discount",
      }),
    });
    assert.equal(created.status, 201);
    await drainWorker(store, env, "worker-a");
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    const connect = store.eventsAfter(runId, 0).filter((row) => row.eventType === "connect_required");
    assert.equal(connect.length, 1);
    assert.equal(store.getRun(runId)?.status, "waiting_for_connect");
    assert.equal(fetches, 0);
    const wire = JSON.stringify(connect);
    assert.equal(wire.includes("Studio"), false);
    assert.equal(wire.toLowerCase().includes("export"), false);
    const connectId = String(connect[0]?.payload.connectId ?? "");
    const finished = await app.request("/api/v1/integrations/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        connectId,
        providerId: "shopify",
        fields: { shop: "acme-store.myshopify.com", secret: "shpat_test" },
      }),
    });
    assert.equal(finished.status, 200, await finished.text());
    await drainWorker(store, env, "worker-a");
    assert.ok(store.enabledCapability("org_acme", "shopify.orders.list"));
    assert.equal(integrationStatus(store, "org_acme", { product: "shopify" }).status, "connected");
  });

  it("lists integrations and starts a connect without a run", async () => {
    const { app, auth } = await boot();
    const listed = await app.request("/api/v1/integrations", { headers: auth });
    assert.equal(listed.status, 200);
    const catalog = ((await listed.json()) as { data: { catalog: Array<{ id: string }> } }).data;
    assert.ok(catalog.catalog.some((row) => row.id === "shopify"));
    const started = await app.request("/api/v1/integrations/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ product: "shopify" }),
    });
    assert.equal(started.status, 200);
    const body = (await started.json()) as {
      data: { status: string; connectId: string; fields: Array<{ key: string }> };
    };
    assert.equal(body.data.status, "connect_required");
    assert.ok(body.data.connectId);
    assert.ok(body.data.fields.some((row) => row.key === "shop"));
  });

  it("creates Sales Manager inbox tasks from a granted custom tool without leaking emails", async () => {
    let fetches = 0;
    const { store, env, app, auth, workforce } = await boot({
      lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn,
      fetch: async () => {
        fetches += 1;
        return new Response(
          JSON.stringify({
            items: [
              { email: "a@x.com", country: "MX", language: "es", daysSinceLastOrder: 120 },
              { email: "b@x.com", country: "US", language: "en", daysSinceLastOrder: 200 },
              { email: "c@x.com", country: "MX", language: "es", daysSinceLastOrder: 10 },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const attach = await app.request("/api/v1/studio/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        items: [
          {
            kind: "openapi",
            name: "Shop",
            purpose: "shop",
            origin: "https://shop.example.test",
            credential: { label: "shop", kind: "bearer", secret: "tok_secret_value" },
            operations: [
              { toolId: "shop.customers.list", risk: "low", binding: { method: "GET", path: "/customers" } },
            ],
          },
          {
            kind: "openapi",
            name: "Mail",
            purpose: "outbound",
            origin: "https://mail.example.test",
            credential: { label: "mail", kind: "bearer", secret: "mail_tok" },
            operations: [
              { toolId: "mail.send", risk: "external_write", binding: { method: "POST", path: "/send" } },
            ],
          },
        ],
      }),
    });
    assert.equal(attach.status, 201, await attach.text());
    const custom = await app.request("/api/v1/studio/custom-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        items: [
          {
            toolId: "customers.find_churned",
            definition: {
              steps: [{ toolId: "shop.customers.list", version: 1, filter: { daysSinceLastOrder: { gte: 90 } } }],
              groupBy: ["country", "language"],
            },
          },
        ],
      }),
    });
    assert.equal(custom.status, 201, await custom.text());
    grant(store, ["shop.customers.list", "customers.find_churned", "task.create"]);
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        prompt: "look for churned customers and send them a reminder",
      }),
    });
    assert.equal(created.status, 201);
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    await drainWorker(store, { ...env, workforce, fetch: async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({
          items: [
            { email: "a@x.com", country: "MX", language: "es", daysSinceLastOrder: 120 },
            { email: "b@x.com", country: "US", language: "en", daysSinceLastOrder: 200 },
            { email: "c@x.com", country: "MX", language: "es", daysSinceLastOrder: 10 },
          ],
        }),
        { status: 200 },
      );
    }, lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn }, "worker-a");
    const complete = store.eventsAfter(runId, 0).find((row) => row.eventType === "message_complete");
    assert.ok(complete);
    assert.match(String(complete.payload.content), /inbox tasks|segments|customers/i);
    assert.equal(JSON.stringify(complete).includes("a@x.com"), false);
    const invocation = [...store.invocations.values()].find((row) => row.tool === "customers.find_churned");
    assert.ok(invocation);
    assert.equal(JSON.stringify(invocation.result).includes("a@x.com"), false);
    assert.ok(invocation.resultSealed);
    const tasks = await workforce.listTasks({ orgId: "org_acme" });
    assert.ok(tasks.length >= 2);
    const manager = [...store.principals.values()].find((row) => /sales manager/i.test(row.displayName));
    assert.ok(tasks.every((task) => task.assigneePrincipalId === manager?.id));
    assert.ok(fetches >= 1);
    assert.equal(
      [...store.runs.values()].filter((row) => row.id !== runId && row.prompt.includes("churned")).length,
      0,
    );
  });

  it("accepts a fresh signed webhook and rejects replay, stale, and bad signatures", async () => {
    const { store, app, auth, workforce } = await boot();
    const attached = await app.request("/api/v1/studio/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        items: [
          {
            kind: "webhook",
            name: "Hooks",
            origin: "https://hooks.example.test",
            credential: { label: "hook", kind: "webhook_secret", secret: "hook_secret" },
            operations: [],
          },
        ],
      }),
    });
    const attachedBody = (await attached.json()) as {
      success: boolean;
      data?: { results: Array<{ connectorId: string }> };
      error?: { message: string };
    };
    assert.equal(attached.status, 201, attachedBody.error?.message);
    const connectorId = attachedBody.data!.results[0].connectorId;
    const rawBody = "{\"event\":\"order.paid\"}";
    const timestamp = String(Date.now());
    const nonce = "nonce-1";
    const signature = webhookSignature("hook_secret", timestamp, nonce, rawBody);
    const ok = await app.request(`/api/v1/hooks/${connectorId}`, {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-nonce": nonce,
        "x-webhook-signature": signature,
      },
      body: rawBody,
    });
    assert.equal(ok.status, 200, await ok.text());
    const replay = await app.request(`/api/v1/hooks/${connectorId}`, {
      method: "POST",
      headers: {
        "x-webhook-timestamp": timestamp,
        "x-webhook-nonce": nonce,
        "x-webhook-signature": signature,
      },
      body: rawBody,
    });
    assert.equal(replay.status, 409);
    const stale = await app.request(`/api/v1/hooks/${connectorId}`, {
      method: "POST",
      headers: {
        "x-webhook-timestamp": String(Date.now() - 400_000),
        "x-webhook-nonce": "nonce-2",
        "x-webhook-signature": webhookSignature(
          "hook_secret",
          String(Date.now() - 400_000),
          "nonce-2",
          rawBody,
        ),
      },
      body: rawBody,
    });
    assert.equal(stale.status, 400);
    const bad = await app.request(`/api/v1/hooks/${connectorId}`, {
      method: "POST",
      headers: {
        "x-webhook-timestamp": String(Date.now()),
        "x-webhook-nonce": "nonce-3",
        "x-webhook-signature": "00",
      },
      body: rawBody,
    });
    assert.equal(bad.status, 401);
    const tasks = await workforce.listTasks({ orgId: "org_acme" });
    assert.equal(tasks.some((task) => task.name.includes("Webhook")), true);
    assert.ok(store.webhookDeliveries.size >= 1);
  });

  it("patches name/origin and deletes a connector from the list", async () => {
    const { store, app, auth } = await boot();
    const attached = await app.request("/api/v1/studio/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        items: [
          {
            kind: "openapi",
            name: "Shop",
            purpose: "shop",
            origin: "https://shop.example.test",
            credential: { label: "shop", kind: "bearer", secret: "tok_secret_value" },
            operations: [
              { toolId: "shop.customers.list", risk: "low", binding: { method: "GET", path: "/customers" } },
            ],
          },
        ],
      }),
    });
    const attachedBody = (await attached.json()) as {
      success: boolean;
      data?: { results: Array<{ connectorId: string }> };
      error?: { message: string };
    };
    assert.equal(attached.status, 201, attachedBody.error?.message);
    const connectorId = attachedBody.data!.results[0].connectorId;

    const patched = await app.request(`/api/v1/integrations/${connectorId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "Shop EU", origin: "https://eu.shop.example.test", secret: "tok_rotated" }),
    });
    const patchedJson = (await patched.json()) as {
      success: boolean;
      data?: { connector: { name: string; origin: string; status: string } };
      error?: { message: string };
    };
    assert.equal(patched.status, 200, patchedJson.error?.message);
    assert.equal(patchedJson.data?.connector.name, "Shop EU");
    assert.equal(patchedJson.data?.connector.origin, "https://eu.shop.example.test");
    assert.equal(patchedJson.data?.connector.status, "active");
    assert.equal(JSON.stringify(patchedJson).includes("tok_rotated"), false);

    const removed = await app.request(`/api/v1/integrations/${connectorId}`, {
      method: "DELETE",
      headers: auth,
    });
    const removedJson = (await removed.json()) as { success: boolean; error?: { message: string } };
    assert.equal(removed.status, 200, removedJson.error?.message);
    const listed = await app.request("/api/v1/integrations", { headers: auth });
    const listedBody = (await listed.json()) as { data: { connectors: Array<{ id: string }> } };
    assert.equal(listedBody.data.connectors.some((row) => row.id === connectorId), false);
    assert.equal(store.connectors.get(connectorId)?.status, "disabled");
  });
});
