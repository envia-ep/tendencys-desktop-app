import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachConnector } from "./connectors.ts";
import { generateVaultKey } from "./crypto.ts";
import { executeCustomTool, findChurnedDefinition, saveCustomTool } from "./custom-tools.ts";
import { evaluatePolicy } from "./policy.ts";
import { inheritCustomRisk } from "./registry.ts";
import { JarvisStore } from "./store.ts";

const vault = { vaultKey: generateVaultKey() };

describe("custom tools", () => {
  it("inherits external_write when any step is a write", () => {
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
    const custom = saveCustomTool(store, {
      orgId: "acme",
      toolId: "customers.nudge",
      definition: { steps: [{ toolId: "mail.send", version: 1 }] },
    });
    assert.equal(inheritCustomRisk(store, "acme", custom), "external_write");
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: [],
        grantedToolIds: ["customers.nudge"],
        tool: "customers.nudge",
      }),
      "ALLOW_WITH_APPROVAL",
    );
  });

  it("DENY when a pinned step is missing or ungranted", async () => {
    const store = new JarvisStore();
    const custom = saveCustomTool(store, {
      orgId: "acme",
      toolId: "customers.find_churned",
      definition: findChurnedDefinition("shop.customers.list", 1),
    });
    const missing = await executeCustomTool(store, "acme", custom.toolId, {}, async () => []);
    assert.equal("error" in missing && missing.error, "step_ungranted");
    attachConnector(store, vault, {
      orgId: "acme",
      createdBy: "user_1",
      kind: "openapi",
      name: "Shop",
      purpose: "shop",
      origin: "https://shop.example.test",
      credential: { label: "shop", kind: "bearer", secret: "tok" },
      operations: [{ toolId: "shop.customers.list", risk: "low", binding: { method: "GET", path: "/customers" } }],
    });
    const denied = await executeCustomTool(
      store,
      "acme",
      custom.toolId,
      {},
      async () => [{ country: "MX", language: "es", daysSinceLastOrder: 120 }],
      [],
    );
    assert.equal("error" in denied && denied.error, "step_ungranted");
  });

  it("groups fixture customers by country and language", async () => {
    const store = new JarvisStore();
    attachConnector(store, vault, {
      orgId: "acme",
      createdBy: "user_1",
      kind: "openapi",
      name: "Shop",
      purpose: "shop",
      origin: "https://shop.example.test",
      credential: { label: "shop", kind: "bearer", secret: "tok" },
      operations: [{ toolId: "shop.customers.list", risk: "low", binding: { method: "GET", path: "/customers" } }],
    });
    saveCustomTool(store, {
      orgId: "acme",
      toolId: "customers.find_churned",
      definition: findChurnedDefinition("shop.customers.list", 1),
    });
    const executed = await executeCustomTool(
      store,
      "acme",
      "customers.find_churned",
      {},
      async () => [
        { country: "MX", language: "es", daysSinceLastOrder: 120 },
        { country: "US", language: "en", daysSinceLastOrder: 200 },
        { country: "MX", language: "es", daysSinceLastOrder: 10 },
      ],
      ["shop.customers.list"],
    );
    assert.equal("result" in executed, true);
    if ("result" in executed) {
      const result = executed.result as { total: number; segments: Array<{ country: string; count: number }> };
      assert.equal(result.total, 2);
      assert.equal(result.segments.length, 2);
    }
  });
});
