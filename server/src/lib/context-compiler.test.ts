import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContext } from "./context-compiler.ts";
import { grantDefaultDesktopTools } from "./studio-access.ts";
import { JarvisStore } from "./store.ts";
import { compileAgentFromGraph } from "./studio-compile.ts";

describe("buildContext", () => {
  it("omits empty layers and never lists an ungranted tool", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const created = store.createAgent({
      orgId: "acme",
      name: "Social Specialist",
      handle: "social",
      identity: "You are Social.",
      jobs: "social",
      toolIds: [],
      requestedToolIds: ["linkedin.publish", "memory.recall"],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
      grantRequestedTools: false,
    });
    grantDefaultDesktopTools(store, "acme", created.agent.id);
    compileAgentFromGraph(store, "acme", created.agent.id);
    const version = store.latestVersion(created.agent.id)!;
    const ctx = buildContext({
      store,
      version,
      userId: "user_1",
      prompt: "publish a post",
    });
    assert.equal(ctx.presentedTools.includes("linkedin.publish"), false);
    assert.ok(ctx.presentedTools.includes("memory.recall"));
    assert.equal(ctx.prompt.includes("linkedin.publish"), false);
    assert.equal(ctx.layers.work, "");
    assert.ok(ctx.layers.platform);
    assert.ok(ctx.layers.identity.includes("@social"));
  });

  it("uses thread summary plus recent messages, not the full thread", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    const thread = store.createThread({
      orgId: "acme",
      actorId: "user_1",
      agentId: seeded.agent.id,
    });
    for (let i = 0; i < 40; i += 1) {
      store.addMessage(thread.id, "user", `old line ${i} about invoices`);
    }
    store.addMessage(thread.id, "user", "what is my preference?");
    const run = store.createRun({
      id: "run_1",
      orgId: "acme",
      actorId: "user_1",
      threadId: thread.id,
      agentId: seeded.agent.id,
      agentVersion: seeded.version.id,
      sessionId: "ses_1",
      deviceId: "dev_1",
      prompt: "what is my preference?",
    });
    const ctx = buildContext({
      store,
      version: seeded.version,
      userId: "user_1",
      prompt: "what is my preference?",
      run,
    });
    const mentioned = ctx.layers.conversation.match(/old line/g) ?? [];
    assert.ok(ctx.layers.conversation.includes("Summary:"));
    assert.ok(mentioned.length < 25);
    assert.ok(ctx.layers.conversation.includes("what is my preference?"));
  });

  it("run layer includes the last invocation result and platform forbids later promises", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    const thread = store.createThread({
      orgId: "acme",
      actorId: "user_1",
      agentId: seeded.agent.id,
    });
    const run = store.createRun({
      id: "run_search_ctx",
      orgId: "acme",
      actorId: "user_1",
      threadId: thread.id,
      agentId: seeded.agent.id,
      agentVersion: seeded.version.id,
      sessionId: "ses_1",
      deviceId: "dev_1",
      prompt: "search for the top tennis shoes",
    });
    const step = store.addStep(run.id, "tool_invocation", {
      tool: "web.search",
      arguments: { query: "top tennis shoes" },
    });
    store.createInvocation({
      id: "ti_search",
      runId: run.id,
      runStepId: step.id,
      sessionId: "ses_1",
      deviceId: "dev_1",
      requestId: "req_1",
      side: "cloud",
      tool: "web.search",
      arguments: { query: "top tennis shoes" },
      argsHash: "hash",
      status: "succeeded",
      result: {
        items: [{ title: "Nike Court Lite", url: "https://nike.com/court-lite", snippet: "Court shoe" }],
      },
      grantId: null,
      nonce: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
    const ctx = buildContext({
      store,
      version: seeded.version,
      userId: "user_1",
      prompt: "search for the top tennis shoes",
      run,
    });
    assert.ok(ctx.layers.run.includes("web.search"));
    assert.ok(ctx.layers.run.includes("Nike Court Lite"));
    assert.ok(ctx.layers.platform.includes("final human answer"));
    assert.ok(ctx.layers.platform.includes("Never say you will do something later"));
    assert.ok(ctx.layers.platform.includes("integrations.connect"));
    assert.equal(ctx.layers.platform.includes("Studio"), false);
  });

  it("action history is a sentence, not operational fields", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    store.addActionOutcome({
      orgId: "acme",
      agentId: seeded.agent.id,
      threadId: "thr_1",
      taskId: null,
      runId: "run_1",
      tool: "memory.remember",
      summary: "@jarvis stored a personal memory.",
    });
    const ctx = buildContext({
      store,
      version: seeded.version,
      userId: "user_1",
      prompt: "hello",
    });
    assert.ok(ctx.layers.actions.includes("@jarvis stored a personal memory."));
    assert.equal(ctx.layers.actions.includes("requestId"), false);
    assert.equal(ctx.layers.actions.includes("nonce"), false);
  });

  it("puts task fields in the work layer, not a fake user message", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    store.objectives.set("obj_1", {
      id: "obj_1",
      orgId: "acme",
      name: "Q3 pipeline",
      description: "",
      status: "open",
      projectUnitId: null,
    });
    const ctx = buildContext({
      store,
      version: seeded.version,
      userId: "user_1",
      prompt: "continue",
      task: {
        id: "tsk_1",
        orgId: "acme",
        objectiveId: "obj_1",
        name: "Follow up with Carlos",
        description: "Call about the quote",
        priority: "high",
        assigneePrincipalId: null,
        status: "assigned",
        createdByPrincipalId: null,
        dueAt: null,
        projectUnitId: null,
        resultSummary: "Left a voicemail",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    assert.ok(ctx.layers.work.includes("Follow up with Carlos"));
    assert.ok(ctx.layers.work.includes("high"));
    assert.ok(ctx.layers.work.includes("Q3 pipeline"));
    assert.ok(ctx.layers.work.includes("Left a voicemail"));
    assert.equal(ctx.layers.conversation.includes("[task]"), false);
    assert.equal(ctx.prompt.includes("[task] Follow up"), false);
    assert.ok(ctx.provenance.some((row) => row.kind === "task" && row.id === "tsk_1"));
  });

  it("records versioned skill provenance and trims over-budget layers", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    const skill = { id: "skl_1", orgId: "acme", name: "Sales" };
    const skillVersion = {
      id: "skv_1",
      skillId: skill.id,
      version: 1,
      instructions: "Qualify inbound leads. ".repeat(8_000),
      inputSchema: {},
      outputSchema: {},
      requiredTools: ["memory.recall"],
      requiredKnowledge: [],
      evaluationPolicy: {},
    };
    store.skills.set(skill.id, skill);
    store.skillVersions.set(skillVersion.id, skillVersion);
    seeded.version.skillVersionIds = [skillVersion.id];
    const ctx = buildContext({
      store,
      version: seeded.version,
      userId: "user_1",
      prompt: "qualify leads",
    });
    assert.ok(
      ctx.provenance.some(
        (row) => row.layer === "skills" && row.kind === "skill_version" && row.id === "skv_1",
      ),
    );
    assert.ok(ctx.layers.skills.includes("[trimmed]"));
    assert.ok(ctx.usage.skills.used <= ctx.usage.skills.budget);
    assert.ok(ctx.layers.policies.includes("Memory scopes:"));
    assert.equal(ctx.layers.policies.includes("linkedin.publish"), false);
  });
});
