import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileAgentFromGraph } from "./studio-compile.ts";
import { grantedToolsForAgent } from "./studio-access.ts";
import { JarvisStore } from "./store.ts";
import { DEFAULT_JARVIS_TOOLS } from "./tools.ts";
import { id } from "./ids.ts";

describe("compile agent_version", () => {
  it("emits requested_tool_ids only and pins the skill version in use", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const created = store.createAgent({
      orgId: "acme",
      name: "Qualifier",
      identity: "Qualify leads",
      jobs: "qualify",
      toolIds: [],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
      grantRequestedTools: false,
    });
    const skill = { id: id("skl"), orgId: "acme", name: "Lead Qualification" };
    store.skills.set(skill.id, skill);
    const v1 = {
      id: "skv_v1",
      skillId: skill.id,
      version: 1,
      instructions: "v1 body",
      inputSchema: {},
      outputSchema: {},
      requiredTools: ["memory.recall"],
      requiredKnowledge: [],
      evaluationPolicy: {},
    };
    store.skillVersions.set(v1.id, v1);
    store.agentSkills.set("ask_1", {
      id: "ask_1",
      orgId: "acme",
      agentId: created.agent.id,
      skillId: skill.id,
      skillVersionId: v1.id,
    });
    const compiled = compileAgentFromGraph(store, "acme", created.agent.id)!;
    assert.ok(compiled.requestedToolIds.includes("memory.recall"));
    for (const tool of DEFAULT_JARVIS_TOOLS) {
      assert.ok(compiled.requestedToolIds.includes(tool));
    }
    assert.deepEqual(compiled.skillVersionIds, [v1.id]);
    assert.equal(grantedToolsForAgent(store, "acme", created.agent.id).includes("memory.recall"), false);
    store.skillVersions.set("skv_v2", {
      id: "skv_v2",
      skillId: skill.id,
      version: 2,
      instructions: "v2 body",
      inputSchema: {},
      outputSchema: {},
      requiredTools: ["linkedin.publish"],
      requiredKnowledge: [],
      evaluationPolicy: {},
    });
    const pinned = store.getVersion(compiled.id)!;
    assert.deepEqual(pinned.skillVersionIds, [v1.id]);
    assert.equal(store.skillVersions.get(pinned.skillVersionIds[0])?.instructions, "v1 body");
  });
});
