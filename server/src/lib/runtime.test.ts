import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { generateEd25519 } from "./crypto.ts";
import { executeCloudTool, memoryContentFromArgs, processRun } from "./runtime.ts";
import { grantDefaultDesktopTools } from "./studio-access.ts";
import { JarvisStore } from "./store.ts";
import { createTaskRecord, memoryWorkforce } from "./workforce.ts";

describe("memoryContentFromArgs", () => {
  it("prefers content, then text, fact, or memory", () => {
    assert.equal(memoryContentFromArgs({ content: "likes Spanish invoices" }), "likes Spanish invoices");
    assert.equal(memoryContentFromArgs({ text: "  prefers DHL  " }), "prefers DHL");
    assert.equal(memoryContentFromArgs({ fact: "VIP customer" }), "VIP customer");
    assert.equal(memoryContentFromArgs({ memory: "calls on Fridays" }), "calls on Fridays");
    assert.equal(memoryContentFromArgs({}), "");
  });
});

describe("rememberCloud", () => {
  it("stores aliased text and skips blank facts", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    const thread = store.createThread({
      orgId: "acme",
      actorId: "user_1",
      agentId: seeded.agent.id,
    });
    const run = store.createRun({
      id: "run_remember",
      orgId: "acme",
      actorId: "user_1",
      threadId: thread.id,
      agentId: seeded.agent.id,
      agentVersion: seeded.version.id,
      sessionId: "ses_1",
      deviceId: "dev_1",
      prompt: "remember this",
    });
    const stored = await executeCloudTool(store, run, seeded.version, "memory.remember", {
      text: "loves Spanish invoices",
    });
    assert.deepEqual(stored, {
      memoryId: store.memories[0]?.id,
      stored: true,
    });
    assert.equal(store.memories[0]?.content, "loves Spanish invoices");
    assert.equal(store.memories[0]?.createdByAgentId, seeded.agent.id);

    const skipped = await executeCloudTool(store, run, seeded.version, "memory.remember", {
      content: "   ",
    });
    assert.deepEqual(skipped, { stored: false, reason: "empty_content" });
    assert.equal(store.memories.length, 1);
  });
});

describe("current-task tools", () => {
  it("completes run.taskId and ignores a client-supplied taskId", async () => {
    const store = new JarvisStore();
    const workforce = memoryWorkforce();
    store.ensureOrg("acme", "user_1");
    const human = store.ensureHumanPrincipal("acme", "user_1", "Me");
    const seeded = store.seedDefaultJarvis("acme");
    const agentPrincipal = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    store.upsertDevice({
      id: "dev_1",
      userId: "user_1",
      orgId: "acme",
      publicKey: "pk",
      name: "test",
    });
    const session = store.createSession({
      userId: "user_1",
      orgId: "acme",
      deviceId: "dev_1",
      ttlMs: 60_000,
    });
    const other = await createTaskRecord(
      store,
      workforce,
      { orgId: "acme", name: "Other", createdByPrincipalId: human.id },
      { userId: "user_1", orgId: "acme", sessionId: session.id, deviceId: "dev_1" },
    );
    const current = await createTaskRecord(
      store,
      workforce,
      {
        orgId: "acme",
        name: "Current",
        assigneePrincipalId: agentPrincipal.id,
        createdByPrincipalId: human.id,
      },
      { userId: "user_1", orgId: "acme", sessionId: session.id, deviceId: "dev_1" },
    );
    const run = store.getRun(current.runId!)!;
    const result = await executeCloudTool(
      store,
      run,
      seeded.version,
      "task.complete_current",
      { result_summary: "Analyzed 37 leads.", taskId: other.task.id },
      workforce,
    );
    assert.equal((result as { taskId: string }).taskId, current.task.id);
    assert.equal((await workforce.getTask(current.task.id))?.status, "completed");
    assert.equal((await workforce.getTask(other.task.id))?.status, "planned");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setupSearchRun(store: JarvisStore) {
  store.ensureOrg("acme", "user_1");
  const seeded = store.seedDefaultJarvis("acme");
  const thread = store.createThread({
    orgId: "acme",
    actorId: "user_1",
    agentId: seeded.agent.id,
  });
  const run = store.createRun({
    id: "run_search",
    orgId: "acme",
    actorId: "user_1",
    threadId: thread.id,
    agentId: seeded.agent.id,
    agentVersion: seeded.version.id,
    sessionId: "ses_1",
    deviceId: "dev_1",
    prompt: "search for the top tennis shoes",
  });
  return { seeded, run };
}

describe("runModelTurn search", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("finishes once after a tool turn and a text turn", async () => {
    const store = new JarvisStore();
    const { run } = setupSearchRun(store);
    const keys = generateEd25519();
    let completions = 0;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        completions += 1;
        if (completions === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "I will search for the top tennis shoes. Please wait.",
                    tool: "web.search",
                    arguments: { query: "top tennis shoes" },
                  }),
                },
              },
            ],
          });
        }
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "1. Nike Court Lite — a solid court shoe.",
                }),
              },
            },
          ],
        });
      }
      return jsonResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Nike Court Lite",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Nike Court Lite",
                    url: "https://nike.com/court-lite",
                    start_index: 0,
                    end_index: 15,
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    await processRun(store, run, {
      serverPrivateKeyB64: keys.privateKeyB64,
      modelApiKey: "sk-test",
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
    });
    const messages = store.eventsAfter(run.id, 0).filter((row) => row.eventType === "message_complete");
    assert.equal(messages.length, 1);
    assert.match(String(messages[0]?.payload.content), /Nike Court Lite/);
    assert.equal(String(messages[0]?.payload.content).includes("Please wait"), false);
  });

  it("does not persist a text ack when a tool is also present", async () => {
    const store = new JarvisStore();
    const { run } = setupSearchRun(store);
    const keys = generateEd25519();
    let completions = 0;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        completions += 1;
        if (completions === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "I will look that up now.",
                    tool: "web.search",
                    arguments: { query: "top tennis shoes" },
                  }),
                },
              },
            ],
          });
        }
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify({ text: "Here are the shoes." }) } }],
        });
      }
      return jsonResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Asics Gel",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Asics Gel",
                    url: "https://asics.com/gel",
                    start_index: 0,
                    end_index: 9,
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    await processRun(store, run, {
      serverPrivateKeyB64: keys.privateKeyB64,
      modelApiKey: "sk-test",
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
    });
    const spoken = store.messages.filter((row) => row.role === "assistant").map((row) => row.content);
    assert.equal(spoken.some((row) => row.includes("I will look that up now")), false);
    assert.equal(spoken.length, 1);
  });
});

describe("processRun connect before model", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("parks for connect when the model only asks for files", async () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    grantDefaultDesktopTools(store, "acme", seeded.agent.id);
    const thread = store.createThread({
      orgId: "acme",
      actorId: "user_1",
      agentId: seeded.agent.id,
    });
    const run = store.createRun({
      id: "run_connect_model",
      orgId: "acme",
      actorId: "user_1",
      threadId: thread.id,
      agentId: seeded.agent.id,
      agentVersion: seeded.version.id,
      sessionId: "ses_1",
      deviceId: "dev_1",
      prompt:
        "review which customers bought last month but have not bought this month and send them an email",
    });
    const keys = generateEd25519();
    let completions = 0;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        completions += 1;
        return jsonResponse({
          choices: [
            {
              message: {
                content:
                  "Do you have the sales data files available for upload, or should I open Shopify?",
              },
            },
          ],
        });
      }
      return jsonResponse({});
    });
    await processRun(store, run, {
      serverPrivateKeyB64: keys.privateKeyB64,
      modelApiKey: "sk-test",
      modelBaseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
    });
    const connect = store.eventsAfter(run.id, 0).filter((row) => row.eventType === "connect_required");
    assert.equal(connect.length, 1);
    assert.equal(store.getRun(run.id)?.status, "waiting_for_connect");
    assert.equal(completions, 0);
    const spoken = store.messages.filter((row) => row.role === "assistant").map((row) => row.content);
    assert.equal(spoken.some((row) => /upload|Shopify|export/i.test(row)), false);
  });
});
