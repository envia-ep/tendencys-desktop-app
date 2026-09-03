import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeOrigin,
  attachConnector,
  executeCapability,
  redactConnectorResult,
  removeConnector,
  sanitizeOrigin,
  updateConnector,
  verifyWebhook,
  webhookSignature,
  type LookupFn,
} from "./connectors.ts";
import { listIntegrations } from "./integrations.ts";
import { generateVaultKey, openSecret } from "./crypto.ts";
import { evaluatePolicy } from "./policy.ts";
import { presentedRegistryTools } from "./registry.ts";
import { executeCloudTool } from "./runtime.ts";
import { memoryRuntime } from "./runtime-repo.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey() };

function attachShop(store: JarvisStore, risk: "low" | "sensitive_read" | "external_write" = "low") {
  return attachConnector(store, vault, {
    orgId: "acme",
    createdBy: "user_1",
    kind: "openapi",
    name: "Shop",
    purpose: "shop",
    origin: "https://shop.example.test",
    credential: { label: "shop-token", kind: "bearer", secret: "tok_secret_value" },
    operations: [
      {
        toolId: "shop.customers.list",
        risk,
        binding: { method: "GET", path: "/customers" },
      },
    ],
  });
}

describe("connectors", () => {
  it("seals the credential and never stores the plaintext token", () => {
    const store = new JarvisStore();
    const attached = attachShop(store);
    assert.equal(attached.credential.sealed.includes("tok_secret_value"), false);
    const opened = openSecret({
      sealed: attached.credential.sealed,
      masterKey: vault.vaultKey,
      orgId: "acme",
      recordId: attached.credential.id,
      kind: attached.credential.kind,
      keyVersion: attached.credential.keyVersion,
    });
    assert.equal(opened, "tok_secret_value");
  });

  it("denies loopback, RFC1918, and metadata origins before fetch", async () => {
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    };
    assert.throws(() => sanitizeOrigin("https://127.0.0.1"), /egress_denied/);
    const blocked: LookupFn = (async () => [{ address: "10.0.0.4", family: 4 }]) as LookupFn;
    await assert.rejects(
      () => assertSafeOrigin("https://shop.example.test", blocked),
      /egress_denied/,
    );
    const meta: LookupFn = (async () => [{ address: "169.254.169.254", family: 4 }]) as LookupFn;
    await assert.rejects(
      () => assertSafeOrigin("https://shop.example.test", meta),
      /egress_denied/,
    );
    assert.equal(fetches, 0);
    void fetchFn;
  });

  it("executes OpenAPI with the vault token and redacts customer lists", async () => {
    const store = new JarvisStore();
    attachShop(store);
    let auth = "";
    const result = await executeCapability(
      store,
      vault,
      "acme",
      "shop.customers.list",
      {},
      {
        lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn,
        fetch: async (_url, init) => {
          auth = String((init?.headers as Record<string, string>).Authorization ?? "");
          return new Response(
            JSON.stringify({
              items: [{ email: "a@x.com", country: "MX", language: "es" }],
            }),
            { status: 200 },
          );
        },
      },
    );
    assert.equal(auth, "Bearer tok_secret_value");
    const redacted = redactConnectorResult(result);
    assert.equal(redacted.count, 1);
    assert.equal(JSON.stringify(redacted).includes("a@x.com"), false);
  });

  it("bumps capability version and omits the disabled row from presentedTools", () => {
    const store = new JarvisStore();
    attachShop(store, "low");
    attachShop(store, "sensitive_read");
    const enabled = store.enabledCapability("acme", "shop.customers.list");
    assert.equal(enabled?.version, 2);
    assert.equal(enabled?.risk, "sensitive_read");
    assert.equal(
      [...store.capabilities.values()].filter((row) => row.toolId === "shop.customers.list" && !row.enabled).length,
      1,
    );
    assert.deepEqual(presentedRegistryTools(store, "acme", ["shop.customers.list"]), ["shop.customers.list"]);
  });

  it("DENY ungranted registry tools and parks external_write", () => {
    const store = new JarvisStore();
    attachConnector(store, vault, {
      orgId: "acme",
      createdBy: "user_1",
      kind: "openapi",
      name: "Mail",
      purpose: "outbound",
      origin: "https://mail.example.test",
      credential: { label: "mail", kind: "bearer", secret: "mail_tok" },
      operations: [{ toolId: "mail.send", risk: "external_write", binding: { method: "POST", path: "/send" } }],
    });
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["mail.send"],
        tool: "mail.send",
      }),
      "DENY",
    );
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["mail.send"],
        grantedToolIds: ["mail.send"],
        tool: "mail.send",
      }),
      "ALLOW_WITH_APPROVAL",
    );
  });

  it("does not hit the remote twice for a duplicate write", async () => {
    const store = new JarvisStore();
    attachConnector(store, vault, {
      orgId: "acme",
      createdBy: "user_1",
      kind: "openapi",
      name: "Mail",
      purpose: "outbound",
      origin: "https://mail.example.test",
      credential: { label: "mail", kind: "bearer", secret: "mail_tok" },
      operations: [{ toolId: "mail.send", risk: "external_write", binding: { method: "POST", path: "/send" } }],
    });
    const seeded = store.seedDefaultJarvis("acme");
    const run = store.createRun({
      id: "run_1",
      orgId: "acme",
      actorId: "user_1",
      threadId: "thr_1",
      agentId: seeded.agent.id,
      agentVersion: seeded.version.id,
      sessionId: "ses_1",
      deviceId: "dev1",
      prompt: "send",
    });
    let fetches = 0;
    const keys = {
      serverPrivateKeyB64: "x",
      modelApiKey: null,
      modelBaseUrl: "",
      modelName: "",
      vaultKey: vault.vaultKey,
      vaultKeyPrevious: null,
      runtime: memoryRuntime(store),
      lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };
    await executeCloudTool(store, run, seeded.version, "mail.send", { idempotencyKey: "dup-1" }, undefined, keys);
    await executeCloudTool(store, run, seeded.version, "mail.send", { idempotencyKey: "dup-1" }, undefined, keys);
    assert.equal(fetches, 1);
  });

  it("edit rotates the secret and sends the new token to the new origin", async () => {
    const store = new JarvisStore();
    const attached = attachShop(store);
    updateConnector(store, vault, {
      orgId: "acme",
      connectorId: attached.connector.id,
      name: "Shop EU",
      origin: "https://eu.shop.example.test",
      secret: "tok_rotated",
    });
    const listed = listIntegrations(store, "acme");
    assert.equal(listed.connectors[0]?.name, "Shop EU");
    assert.equal(listed.connectors[0]?.origin, "https://eu.shop.example.test");
    assert.equal(listed.connectors[0]?.status, "active");
    assert.equal(JSON.stringify(listed).includes("tok_rotated"), false);

    let hit = "";
    let auth = "";
    const result = await executeCapability(
      store,
      vault,
      "acme",
      "shop.customers.list",
      {},
      {
        lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn,
        fetch: async (url, init) => {
          hit = String(url);
          auth = String((init?.headers as Record<string, string>).Authorization ?? "");
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        },
      },
    );
    assert.equal(hit.startsWith("https://eu.shop.example.test/"), true);
    assert.equal(auth, "Bearer tok_rotated");
    assert.equal((result as { items?: unknown[] }).items?.length, 0);
  });

  it("remove disables the connector so list drops it and execute does not fetch", async () => {
    const store = new JarvisStore();
    const attached = attachShop(store);
    removeConnector(store, { orgId: "acme", connectorId: attached.connector.id });
    assert.equal(store.connectors.get(attached.connector.id)?.status, "disabled");
    assert.equal(store.enabledCapability("acme", "shop.customers.list"), undefined);
    assert.equal(listIntegrations(store, "acme").connectors.length, 0);

    let fetches = 0;
    const result = await executeCapability(
      store,
      vault,
      "acme",
      "shop.customers.list",
      {},
      {
        lookup: (async () => [{ address: "203.0.113.10", family: 4 }]) as LookupFn,
        fetch: async () => {
          fetches += 1;
          return new Response("{}", { status: 200 });
        },
      },
    );
    assert.deepEqual(result, { error: "capability_missing" });
    assert.equal(fetches, 0);
  });

  it("verifies webhook freshness and rejects stale or bad signatures", () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    const timestamp = String(now);
    const nonce = "n1";
    const rawBody = "{\"ok\":true}";
    const signature = webhookSignature("hook_secret", timestamp, nonce, rawBody);
    assert.equal(
      verifyWebhook({ secret: "hook_secret", timestamp, nonce, rawBody, signature, nowMs: now }),
      "ok",
    );
    assert.equal(
      verifyWebhook({
        secret: "hook_secret",
        timestamp: String(now - 400_000),
        nonce,
        rawBody,
        signature: webhookSignature("hook_secret", String(now - 400_000), nonce, rawBody),
        nowMs: now,
      }),
      "stale",
    );
    assert.equal(
      verifyWebhook({ secret: "hook_secret", timestamp, nonce, rawBody, signature: "deadbeef", nowMs: now }),
      "unauthorized",
    );
  });
});
