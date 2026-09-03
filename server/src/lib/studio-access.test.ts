import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePolicy } from "./policy.ts";
import { applyAutonomyPreset, effectiveTools, grantedToolsForAgent, requestedToolsForAgent } from "./studio-access.ts";
import { JarvisStore } from "./store.ts";
import { id } from "./ids.ts";

describe("requested vs granted", () => {
  it("never treats skill required tools as granted", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const created = store.createAgent({
      orgId: "acme",
      name: "Social",
      identity: "Social",
      jobs: "post",
      toolIds: [],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
      grantRequestedTools: false,
    });
    const skill = { id: id("skl"), orgId: "acme", name: "Publish LinkedIn" };
    store.skills.set(skill.id, skill);
    store.skillVersions.set("skv_v1", {
      id: "skv_v1",
      skillId: skill.id,
      version: 1,
      instructions: "v1",
      inputSchema: {},
      outputSchema: {},
      requiredTools: ["linkedin.publish"],
      requiredKnowledge: [],
      evaluationPolicy: {},
    });
    store.agentSkills.set(id("ask"), {
      id: "ask_1",
      orgId: "acme",
      agentId: created.agent.id,
      skillId: skill.id,
      skillVersionId: "skv_v1",
    });
    const requested = requestedToolsForAgent(store, "acme", created.agent.id);
    const granted = grantedToolsForAgent(store, "acme", created.agent.id);
    assert.deepEqual(requested, ["linkedin.publish"]);
    assert.equal(granted.includes("linkedin.publish"), false);
    assert.deepEqual(effectiveTools(requested, granted), []);
  });

  it("autonomy 5 still DENY privileged tools unless explicitly granted — and even then DENY wins", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const created = store.seedDefaultJarvis("acme");
    const principal = store.ensureAgentPrincipal("acme", created.agent.id, "Jarvis");
    store.upsertAccessGrant({
      orgId: "acme",
      principalId: principal.id,
      toolId: "screenshots.capture",
      kind: "can_use",
    });
    applyAutonomyPreset(store, "acme", principal.id, 5);
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["screenshots.capture"],
        grantedToolIds: ["screenshots.capture"],
        principalId: principal.id,
        tool: "screenshots.capture",
      }),
      "DENY",
    );
  });
});
