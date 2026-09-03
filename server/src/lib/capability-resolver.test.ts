import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachConnector } from "./connectors.ts";
import { resolveCapabilities, type RequiredCapability } from "./capability-resolver.ts";
import { generateVaultKey } from "./crypto.ts";
import { principalForAgent } from "./org-graph.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey() };
const need: RequiredCapability[] = [{ id: "commerce.customer.search", purpose: "commerce" }];

function attachShop(store: JarvisStore) {
  return attachConnector(store, vault, {
    orgId: "acme",
    createdBy: "user_1",
    kind: "openapi",
    name: "Shop",
    purpose: "shop",
    origin: "https://shop.example.test",
    credential: { label: "shop-token", kind: "bearer", secret: "tok" },
    operations: [
      { toolId: "shop.customers.list", risk: "sensitive_read", binding: { method: "GET", path: "/customers" } },
    ],
  });
}

describe("resolveCapabilities", () => {
  it("reports MISSING when no connector provides the purpose", () => {
    const store = new JarvisStore();
    const { agent } = store.seedDefaultJarvis("acme");
    const [row] = resolveCapabilities(store, "acme", agent.id, need);
    assert.equal(row.status, "MISSING");
  });

  it("reports NOT_GRANTED when a connector exists but the agent lacks the grant", () => {
    const store = new JarvisStore();
    const { agent } = store.seedDefaultJarvis("acme");
    attachShop(store);
    const [row] = resolveCapabilities(store, "acme", agent.id, need);
    assert.equal(row.status, "NOT_GRANTED");
    assert.ok(row.connectorId);
  });

  it("reports FOUND once the agent is granted the connector tool", () => {
    const store = new JarvisStore();
    const { agent } = store.seedDefaultJarvis("acme");
    attachShop(store);
    const principal = principalForAgent(store, "acme", agent.id)!;
    store.upsertAccessGrant({ orgId: "acme", principalId: principal.id, toolId: "shop.customers.list", kind: "can_use" });
    const [row] = resolveCapabilities(store, "acme", agent.id, need);
    assert.equal(row.status, "FOUND");
  });

  it("reports DISABLED when the only connector is disabled", () => {
    const store = new JarvisStore();
    const { agent } = store.seedDefaultJarvis("acme");
    const { connector } = attachShop(store);
    store.connectors.get(connector.id)!.status = "disabled";
    const [row] = resolveCapabilities(store, "acme", agent.id, need);
    assert.equal(row.status, "DISABLED");
  });

  it("reports AUTH_EXPIRED when health says the connector token expired", () => {
    const store = new JarvisStore();
    const { agent } = store.seedDefaultJarvis("acme");
    const { connector } = attachShop(store);
    const health = (id: string) => (id === connector.id ? { state: "AUTH_EXPIRED" } : undefined);
    const [row] = resolveCapabilities(store, "acme", agent.id, need, health);
    assert.equal(row.status, "AUTH_EXPIRED");
  });
});
