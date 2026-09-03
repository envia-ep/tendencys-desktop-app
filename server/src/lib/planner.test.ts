import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPrompt, planRegistryFallback } from "./planner.ts";
import { JarvisStore } from "./store.ts";

describe("planPrompt", () => {
  it("maps search phrases to web.search", () => {
    const planned = planPrompt("search for the top tennis shoes");
    assert.equal(planned[0]?.tool, "web.search");
    assert.equal(planned[0]?.arguments.query, "the top tennis shoes");
  });
});

describe("planRegistryFallback", () => {
  it("starts a connect instead of sending the user to Studio", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const { agent } = store.seedDefaultJarvis("acme");
    const planned = planRegistryFallback(
      store,
      "acme",
      agent.id,
      [],
      "review which customers bought last month and send them an email",
    );
    assert.equal(planned.kind, "actions");
    if (planned.kind !== "actions") {
      return;
    }
    assert.ok(planned.actions.every((row) => row.tool === "integrations.connect"));
    assert.equal(JSON.stringify(planned).includes("Studio"), false);
    assert.equal(JSON.stringify(planned).toLowerCase().includes("export"), false);
  });
});
