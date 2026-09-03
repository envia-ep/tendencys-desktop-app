import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateVaultKey } from "./crypto.ts";
import {
  addSource,
  answer,
  assembleCredential,
  createDraft,
  discover,
  parseCurl,
  parseOpenApi,
  parsePostman,
  register,
} from "./integration-engineer.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey(), vaultKeyPrevious: null };

const OPENAPI = JSON.stringify({
  servers: [{ url: "https://api.acme.test" }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/customers": { get: { operationId: "listCustomers", summary: "List customers" } },
    "/orders/{id}/refund": { post: { operationId: "refundOrder", summary: "Refund an order" } },
  },
});

describe("integration engineer parsers", () => {
  it("parses OpenAPI operations, base url and auth", () => {
    const parsed = parseOpenApi(OPENAPI);
    assert.ok(parsed);
    assert.equal(parsed?.baseUrl, "https://api.acme.test");
    assert.equal(parsed?.auth?.kind, "bearer");
    assert.equal(parsed?.operations.length, 2);
    const refund = parsed?.operations.find((op) => op.method === "POST");
    assert.equal(refund?.risk, "external_write");
  });

  it("parses a curl command into one operation", () => {
    const parsed = parseCurl(`curl -X POST https://api.acme.test/widgets -H 'Authorization: Bearer x' -d '{}'`);
    assert.ok(parsed);
    assert.equal(parsed?.operations[0]?.method, "POST");
    assert.equal(parsed?.baseUrl, "https://api.acme.test");
    assert.equal(parsed?.auth?.kind, "bearer");
  });

  it("parses a Postman collection", () => {
    const collection = JSON.stringify({
      item: [
        { name: "List", request: { method: "GET", url: { raw: "https://api.acme.test/things" } } },
        { name: "Folder", item: [{ name: "Make", request: { method: "POST", url: "https://api.acme.test/things" } }] },
      ],
    });
    const parsed = parsePostman(collection);
    assert.equal(parsed?.operations.length, 2);
    assert.equal(parsed?.baseUrl, "https://api.acme.test");
  });
});

describe("integration engineer pipeline", () => {
  it("discovers OpenAPI and proposes capabilities for review", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const draft = createDraft(store, { orgId: "acme", createdBy: "user_1", name: "Acme API" });
    addSource(store, draft, { type: "openapi", content: OPENAPI });
    await discover(store, draft);
    assert.equal(draft.status, "REVIEW_REQUIRED");
    assert.equal(draft.proposedCapabilities.length, 2);
    assert.ok(draft.proposedCapabilities.some((cap) => cap.capabilityId === "acme_api.customers.list"));
  });

  it("asks for auth when the spec omits it, then proceeds", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const draft = createDraft(store, { orgId: "acme", createdBy: "user_1", name: "Acme API" });
    addSource(store, draft, {
      type: "openapi",
      content: JSON.stringify({
        servers: [{ url: "https://api.acme.test" }],
        paths: { "/ping": { get: { operationId: "ping" } } },
      }),
    });
    await discover(store, draft);
    assert.equal(draft.status, "AUTH_REQUIRED");
    assert.ok(draft.questions[0]?.toLowerCase().includes("authentication"));
    answer(draft, { authKind: "bearer" });
    assert.equal(draft.status, "REVIEW_REQUIRED");
    assert.equal(draft.discoveredAuth?.kind, "bearer");
  });

  it("registers an approved draft as a live connector and grants tools", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const { agent } = store.seedDefaultJarvis("acme");
    const draft = createDraft(store, { orgId: "acme", createdBy: "user_1", name: "Acme API" });
    addSource(store, draft, { type: "openapi", content: OPENAPI });
    await discover(store, draft);
    const result = register(store, vault, draft, {
      agentId: agent.id,
      createdBy: "user_1",
      secret: "token_123",
    });
    assert.equal(draft.status, "READY");
    assert.equal(result.toolIds.length, 2);
    assert.ok(store.enabledCapability("acme", "acme_api.customers.list"));
  });

  it("registers a multi-field credential via the fields map", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const { agent } = store.seedDefaultJarvis("acme");
    const draft = createDraft(store, { orgId: "acme", createdBy: "user_1", name: "Acme API" });
    addSource(store, draft, { type: "openapi", content: OPENAPI });
    await discover(store, draft);
    const result = register(store, vault, draft, {
      agentId: agent.id,
      createdBy: "user_1",
      fields: { secret: "token_from_fields" },
    });
    assert.equal(draft.status, "READY");
    assert.equal(result.toolIds.length, 2);
  });
});

describe("assembleCredential", () => {
  it("packs header_map fields into a JSON secret, dropping reserved keys", () => {
    const { secret } = assembleCredential("header_map", {
      fields: { "X-Api-Key": "abc", "X-Region": "us", operations: "ignored" },
    });
    assert.deepEqual(JSON.parse(secret), { "X-Api-Key": "abc", "X-Region": "us" });
  });

  it("splits an MCP credential into origin (serverUrl) + token", () => {
    const { secret, origin } = assembleCredential("mcp", {
      fields: { serverUrl: "https://mcp.acme/v1", token: "mcp_tok" },
    });
    assert.equal(origin, "https://mcp.acme/v1");
    assert.equal(secret, "mcp_tok");
  });

  it("uses the lone secret field for bearer auth", () => {
    const { secret } = assembleCredential("bearer", { fields: { secret: "tok" } });
    assert.equal(secret, "tok");
  });
});
