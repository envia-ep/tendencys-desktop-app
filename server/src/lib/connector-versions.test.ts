import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachConnector } from "./connectors.ts";
import { latestConnectorVersion, versionRefsForTool } from "./connector-versions.ts";
import { generateVaultKey } from "./crypto.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey() };

function attachShop(store: JarvisStore, risk: "low" | "sensitive_read" = "low") {
  return attachConnector(store, vault, {
    orgId: "acme",
    createdBy: "user_1",
    kind: "openapi",
    name: "Shop",
    purpose: "shop",
    origin: "https://shop.example.test",
    credential: { label: "shop-token", kind: "bearer", secret: "tok_secret_value" },
    operations: [{ toolId: "shop.customers.list", risk, binding: { method: "GET", path: "/customers" } }],
  });
}

describe("connector versions", () => {
  it("records an immutable snapshot per connector revision + capability version", () => {
    const store = new JarvisStore();
    const first = attachShop(store, "low");
    assert.equal(first.connectorVersion.revision, 1);
    assert.equal(first.capabilityVersions.length, 1);
    assert.equal(first.capabilityVersions[0].version, 1);
    assert.equal(first.capabilityVersions[0].connectorVersionId, first.connectorVersion.id);

    // Re-attach with a changed spec bumps both connector revision and capability version.
    const second = attachShop(store, "sensitive_read");
    assert.equal(second.connectorVersion.revision, 2);
    assert.equal(second.capabilityVersions[0].version, 2);
    assert.notEqual(second.connectorVersion.id, first.connectorVersion.id);
    assert.equal(store.connectorVersions.size, 2);
    assert.equal(store.capabilityVersions.size, 2);
    assert.equal(latestConnectorVersion(store, first.connector.id)?.revision, 2);
  });

  it("is idempotent when the spec is unchanged", () => {
    const store = new JarvisStore();
    attachShop(store, "low");
    attachShop(store, "low");
    assert.equal(store.connectorVersions.size, 1);
    assert.equal(store.capabilityVersions.size, 1);
  });

  it("resolves the current version refs for an enabled tool", () => {
    const store = new JarvisStore();
    const attached = attachShop(store, "sensitive_read");
    const refs = versionRefsForTool(store, "acme", "shop.customers.list");
    assert.equal(refs.connectorVersionId, attached.connectorVersion.id);
    assert.equal(refs.capabilityVersionId, attached.capabilityVersions[0].id);
  });

  it("returns null refs for a tool with no connector capability", () => {
    const store = new JarvisStore();
    const refs = versionRefsForTool(store, "acme", "web.search");
    assert.equal(refs.connectorVersionId, null);
    assert.equal(refs.capabilityVersionId, null);
  });
});
