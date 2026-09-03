import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateVaultKey, openSecret } from "./crypto.ts";
import {
  buildAuthorizeUrl,
  completeConnect,
  exchangeOauthToken,
  integrationStatus,
  listIntegrations,
  startConnect,
} from "./integrations.ts";
import { findProviderByAlias } from "./providers.ts";
import { grantedToolsForAgent } from "./studio-access.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey() };

function seed(store: JarvisStore) {
  store.ensureOrg("acme", "user_1");
  return store.seedDefaultJarvis("acme");
}

describe("integrations", () => {
  it("asks for a product when only a purpose is known", () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const started = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      purpose: "commerce",
    });
    assert.equal(started.status, "connect_required");
    if (started.status !== "connect_required") {
      return;
    }
    assert.equal(started.ask, "product");
    assert.equal(started.provider, null);
    assert.ok(started.candidates.some((row) => row.id === "shopify"));
    assert.equal(JSON.stringify(started).includes("Studio"), false);
    assert.equal(JSON.stringify(started).toLowerCase().includes("export"), false);
  });

  it("uses custom fields for an unknown product", () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const started = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "obscure-crm",
    });
    assert.equal(started.status, "connect_required");
    if (started.status !== "connect_required") {
      return;
    }
    assert.equal(started.provider, "custom");
    assert.deepEqual(
      started.fields.map((row) => row.key),
      ["origin", "secret"],
    );
  });

  it("seals the secret, grants tools, and skips a second connect", () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const started = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
      purpose: "commerce",
      runId: "run_1",
    });
    assert.equal(started.status, "connect_required");
    if (started.status !== "connect_required") {
      return;
    }
    const done = completeConnect(store, vault, {
      connectId: started.connectId,
      fields: { shop: "acme-store.myshopify.com", secret: "shpat_secret_value" },
    });
    assert.equal(done.status, "connected");
    assert.ok(done.toolIds.includes("shopify.orders.list"));
    const credential = [...store.credentials.values()][0];
    assert.ok(credential);
    assert.equal(credential.sealed.includes("shpat_secret_value"), false);
    const opened = openSecret({
      sealed: credential.sealed,
      masterKey: vault.vaultKey,
      orgId: "acme",
      recordId: credential.id,
      kind: credential.kind,
      keyVersion: credential.keyVersion,
    });
    assert.equal(opened, "shpat_secret_value");
    const granted = grantedToolsForAgent(store, "acme", seeded.agent.id);
    assert.ok(granted.includes("shopify.orders.list"));
    const again = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
    });
    assert.equal(again.status, "connected");
    assert.equal(integrationStatus(store, "acme", { product: "shopify" }).status, "connected");
  });

  it("builds an OAuth URL only when env credentials exist", () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const without = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
      env: {},
    });
    assert.equal(without.status, "connect_required");
    if (without.status !== "connect_required") {
      return;
    }
    assert.equal(without.authMethods.some((row) => row.kind === "oauth"), false);
    const withOauth = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
      env: {
        JARVIS_OAUTH_SHOPIFY_CLIENT_ID: "cid",
        JARVIS_OAUTH_SHOPIFY_CLIENT_SECRET: "csec",
      },
    });
    assert.equal(withOauth.status, "connect_required");
    if (withOauth.status !== "connect_required") {
      return;
    }
    assert.ok(withOauth.authMethods.some((row) => row.kind === "oauth"));
    const url = buildAuthorizeUrl({
      spec: findProviderByAlias("shopify")!,
      env: {
        JARVIS_OAUTH_SHOPIFY_CLIENT_ID: "cid",
        JARVIS_OAUTH_SHOPIFY_CLIENT_SECRET: "csec",
      },
      redirectUri: "http://127.0.0.1:8788/api/v1/integrations/oauth/callback",
      state: "st_1",
      fields: { shop: "acme-store" },
    });
    assert.match(url, /acme-store\.myshopify\.com/);
    assert.match(url, /client_id=cid/);
  });

  it("exchanges an OAuth code and stores the access token", async () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const started = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
    });
    assert.equal(started.status, "connect_required");
    if (started.status !== "connect_required") {
      return;
    }
    const token = await exchangeOauthToken({
      spec: findProviderByAlias("shopify")!,
      env: {
        JARVIS_OAUTH_SHOPIFY_CLIENT_ID: "cid",
        JARVIS_OAUTH_SHOPIFY_CLIENT_SECRET: "csec",
      },
      redirectUri: "http://127.0.0.1:8788/callback",
      code: "code_1",
      fields: { shop: "acme-store.myshopify.com" },
      fetchFn: async () =>
        new Response(JSON.stringify({ access_token: "tok_from_oauth" }), { status: 200 }),
    });
    const done = completeConnect(store, vault, {
      connectId: started.connectId,
      fields: { shop: "acme-store.myshopify.com" },
      secret: token,
    });
    assert.equal(done.status, "connected");
    const credential = [...store.credentials.values()][0];
    const opened = openSecret({
      sealed: credential.sealed,
      masterKey: vault.vaultKey,
      orgId: "acme",
      recordId: credential.id,
      kind: credential.kind,
      keyVersion: credential.keyVersion,
    });
    assert.equal(opened, "tok_from_oauth");
  });

  it("lists catalog products and connected connectors without secrets", () => {
    const store = new JarvisStore();
    const seeded = seed(store);
    const started = startConnect(store, {
      orgId: "acme",
      agentId: seeded.agent.id,
      createdBy: "user_1",
      product: "shopify",
    });
    if (started.status !== "connect_required") {
      return;
    }
    completeConnect(store, vault, {
      connectId: started.connectId,
      fields: { shop: "acme-store.myshopify.com", secret: "shpat_secret_value" },
    });
    const listed = listIntegrations(store, "acme", {});
    assert.ok(listed.catalog.some((row) => row.id === "shopify"));
    assert.ok(listed.catalog.some((row) => row.id === "custom"));
    assert.equal(listed.connectors.length, 1);
    assert.equal(listed.connectors[0]?.name, "shopify");
    assert.equal(JSON.stringify(listed).includes("shpat_secret_value"), false);
    assert.equal(JSON.stringify(listed).includes("Studio"), false);
    const shopify = listed.catalog.find((row) => row.id === "shopify");
    const token = shopify?.authMethods
      .find((row) => row.kind === "fields")
      ?.fields.find((row) => row.key === "secret");
    assert.ok(token?.help?.includes("Develop apps"));
    assert.ok(token?.href?.includes("shopify.dev"));
  });
});
