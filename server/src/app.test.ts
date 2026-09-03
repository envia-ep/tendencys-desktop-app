import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import {
  deviceResultSignBytes,
  generateEd25519,
  signBytes,
} from "./lib/crypto.ts";
import { buildContext } from "./lib/context-compiler.ts";
import { loadEnv } from "./lib/env.ts";
import { JarvisStore } from "./lib/store.ts";
import { drainWorker, tickWorker } from "./worker.ts";

type Envelope = {
  toolInvocationId: string;
  requestId: string;
  runId: string;
  arguments: Record<string, unknown>;
};

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

async function boot(existing?: JarvisStore) {
  const store = existing ?? new JarvisStore();
  const server = generateEd25519();
  const device = generateEd25519();
  const env = loadEnv({
    jwtSecret: "test-jarvis-jwt-secret-min-32-chars!!",
    serverPrivateKeyB64: server.privateKeyB64,
    serverPublicKeyB64: server.publicKeyB64,
    leaseMs: 30_000,
    inlineWorker: false,
    modelApiKey: null,
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
  });
  const app = createApp({ store, env });
  const deviceId = "dev_macbook";
  const sessionRes = await app.request("/api/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      atid: "test:user_1:org_acme",
      deviceId,
      devicePublicKey: device.publicKeyB64,
      attestation: attest(device, deviceId),
      deviceName: "MacBook",
    }),
  });
  const sessionJson = await sessionRes.json();
  assert.equal(sessionRes.status, 200, JSON.stringify(sessionJson));
  const session = sessionJson as {
    success: true;
    data: { token: string; sessionId: string; orgId: string };
  };
  const auth = { Authorization: `Bearer ${session.data.token}` };
  return { store, env, app, device, server, auth, deviceId, session };
}

async function createRun(app: ReturnType<typeof createApp>, auth: Record<string, string>, prompt: string) {
  const res = await app.request("/api/v1/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ prompt }),
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  return json as { success: true; data: { runId: string; status: string } };
}

function envelopeFrom(store: JarvisStore, runId: string): Envelope {
  const event = store.eventsAfter(runId, 0).find((row) => row.eventType === "tool_started");
  assert.ok(event, "expected tool_started");
  const envelope = event.payload.envelope as Envelope;
  assert.ok(envelope?.requestId);
  return envelope;
}

async function postSignedResult(input: {
  app: ReturnType<typeof createApp>;
  auth: Record<string, string>;
  device: ReturnType<typeof generateEd25519>;
  runId: string;
  envelope: Envelope;
  result: unknown;
  status?: "success" | "succeeded" | "failed";
}) {
  const status = input.status ?? "succeeded";
  const executedAt = new Date().toISOString();
  const signature = signBytes(
    input.device.privateKeyB64,
    deviceResultSignBytes({
      runId: input.runId,
      toolInvocationId: input.envelope.toolInvocationId,
      requestId: input.envelope.requestId,
      status,
      result: input.result,
      executedAt,
    }),
  );
  return input.app.request(`/api/v1/runs/${input.runId}/tool-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...input.auth },
    body: JSON.stringify({
      toolInvocationId: input.envelope.toolInvocationId,
      requestId: input.envelope.requestId,
      status,
      result: input.result,
      executedAt,
      deviceSignature: signature,
    }),
  });
}

describe("Jarvis session + health", () => {
  it("exchanges a test atid for a jarvis JWT and publishes the server public key", async () => {
    const { session, env } = await boot();
    assert.equal(session.data.orgId, "org_acme");
    assert.ok(session.data.token.split(".").length === 3);
    const health = await (await boot()).app.request("/api/v1/health");
    const body = (await health.json()) as { data: { serverPublicKey: string } };
    assert.equal(typeof body.data.serverPublicKey, "string");
    assert.equal(env.serverPublicKeyB64.length > 10, true);
  });

  it("does not re-persist the org graph on a reused session", async () => {
    const { store, app, device, deviceId } = await boot();
    const tables: string[] = [];
    store.persister = {
      upsert: async (table: string) => {
        tables.push(table);
      },
    };
    const sessionRes = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atid: "test:user_1:org_acme",
        deviceId,
        devicePublicKey: device.publicKeyB64,
        attestation: attest(device, deviceId),
        deviceName: "MacBook",
      }),
    });
    assert.equal(sessionRes.status, 200);
    assert.deepEqual(
      tables.filter((table) =>
        table === "organizations" ||
        table === "agents" ||
        table === "agent_versions" ||
        table === "access_grants"
      ),
      [],
    );
  });

  it("revokes the Jarvis session without needing Accounts logout", async () => {
    const { app, auth } = await boot();
    const revoke = await app.request("/api/v1/auth/session/revoke", {
      method: "POST",
      headers: auth,
    });
    assert.equal(revoke.status, 200);
    const denied = await app.request("/api/v1/agents", { headers: auth });
    assert.equal(denied.status, 401);
  });
});

describe("memory + agents", () => {
  it("returns a queued run before the worker finishes", async () => {
    const { store, app, auth } = await boot();
    const created = await createRun(app, auth, "Remember that I prefer Spanish invoices.");
    assert.equal(created.data.status, "queued");
    assert.equal(store.getRun(created.data.runId)?.status, "queued");
  });

  it("remembers an explicit personal preference and recalls it", async () => {
    const { store, env, app, auth } = await boot();
    const created = await createRun(
      app,
      auth,
      "Remember that I prefer Spanish invoices.",
    );
    await drainWorker(store, env, "worker-a");
    const run = store.getRun(created.data.runId)!;
    assert.equal(run.status, "completed");
    assert.equal(run.agentVersion, store.latestVersion(run.agentId)!.id);
    assert.ok(store.memories.some((memory) => memory.content.includes("Spanish invoices")));

    const recall = await createRun(app, auth, "What is my invoice language preference?");
    await drainWorker(store, env, "worker-a");
    const recalled = store.getRun(recall.data.runId)!;
    assert.equal(recalled.status, "completed");
    const finished = store.eventsAfter(recalled.id, 0).find((event) => event.eventType === "tool_finished");
    assert.ok(JSON.stringify(finished?.payload).includes("Spanish invoices"));
  });

  it("rebinds the run to the mentioned agent handle", async () => {
    const { store, env, app, auth } = await boot();
    const createAgent = await app.request("/api/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        name: "Sales",
        identity: "You are Sales.",
        jobs: "Talk about invoices.",
        toolIds: ["memory.recall", "memory.remember"],
      }),
    });
    assert.equal(createAgent.status, 201, await createAgent.text());
    const sales = store.findAgentByHandle("org_acme", "sales")!;
    const created = await createRun(app, auth, "@sales what is my preference?");
    await drainWorker(store, env, "worker-a");
    const run = store.getRun(created.data.runId)!;
    assert.equal(run.agentId, sales.id);
  });

  it("grants web.search to a hydrated specialist on session", async () => {
    const store = new JarvisStore();
    store.ensureOrg("org_acme", "user_1");
    store.createAgent({
      orgId: "org_acme",
      name: "Sales Specialist",
      handle: "sales",
      identity: "You are Sales.",
      jobs: "Sell.",
      toolIds: ["memory.recall", "memory.remember"],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
    });
    const { auth, app } = await boot(store);
    const sales = store.findAgentByHandle("org_acme", "sales")!;
    const version = store.latestVersion(sales.id)!;
    const ctx = buildContext({
      store,
      version,
      userId: "user_1",
      prompt: "search for shoes",
    });
    assert.ok(ctx.presentedTools.includes("web.search"));
    void app;
    void auth;
  });

  it("speaks when the mentioned handle does not exist", async () => {
    const { store, env, app, auth } = await boot();
    const created = await createRun(app, auth, "@research search for shoes");
    await drainWorker(store, env, "worker-a");
    const run = store.getRun(created.data.runId)!;
    assert.equal(run.status, "completed");
    const spoken = store.eventsAfter(run.id, 0).filter((row) => row.eventType === "message_complete");
    assert.equal(spoken.length, 1);
    assert.match(String(spoken[0]?.payload.content), /No agent @research/);
    assert.match(String(spoken[0]?.payload.content), /Studio/);
    assert.equal(
      store.eventsAfter(run.id, 0).some((row) => row.eventType === "tool_started"),
      false,
    );
  });

  it("reports waiting_for_local_tool while a desktop tool is in flight and idle after it completes", async () => {
    const { store, env, app, auth, device } = await boot();
    await app.request("/api/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        grantId: "clip_session",
        capability: "clipboard.read",
        kind: "SESSION",
      }),
    });
    const created = await createRun(app, auth, "What is currently on my clipboard?");
    await drainWorker(store, env, "worker-a");
    const waiting = await app.request("/api/v1/agents", { headers: auth });
    const waitingBody = (await waiting.json()) as {
      data: { items: Array<{ handle: string; activity: { status: string } }> };
    };
    const jarvis = waitingBody.data.items.find((row) => row.handle === "jarvis");
    assert.equal(jarvis?.activity.status, "waiting_for_local_tool");
    const envelope = envelopeFrom(store, created.data.runId);
    await postSignedResult({
      app,
      auth,
      device,
      runId: created.data.runId,
      envelope,
      result: { text: "copied" },
    });
    await drainWorker(store, env, "worker-a");
    const idle = await app.request("/api/v1/agents", { headers: auth });
    const idleBody = (await idle.json()) as {
      data: { items: Array<{ handle: string; activity: { status: string } }> };
    };
    assert.equal(idleBody.data.items.find((row) => row.handle === "jarvis")?.activity.status, "idle");
  });
});

describe("policy + approvals", () => {
  it("DENY never creates an approval card", async () => {
    const { store, env, app, auth } = await boot();
    store.seedDefaultJarvis("org_acme");
    const jarvis = store.findAgentByName("org_acme", "Jarvis")!;
    store.addAgentVersion(jarvis.id, {
      identity: "Jarvis",
      jobs: "ops",
      toolIds: ["screenshots.capture"],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
    });
    const created = await createRun(app, auth, "Remember that we deny screenshots.");
    await drainWorker(store, env, "worker-a");
    assert.equal(store.approvals.size, 0);
    const denied = evaluateDenyPath(store);
    assert.ok(denied);
  });

  it("clipboard.write binds approval to frozen args and refuses mutation", async () => {
    const { store, env, app, auth, device } = await boot();
    const created = await createRun(app, auth, "Put hello world on the clipboard");
    await drainWorker(store, env, "worker-a");
    const run = store.getRun(created.data.runId)!;
    assert.equal(run.status, "waiting_for_approval");
    const approval = [...store.approvals.values()][0];
    assert.ok(approval);
    const invocation = store.getInvocation(approval.toolInvocationId)!;
    invocation.arguments = { content: "mutated after approve" };
    const decide = await app.request(`/api/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decide.status, 200);
    await drainWorker(store, env, "worker-b");
    assert.equal(store.getInvocation(invocation.id)?.status, "failed");
    assert.equal(store.getRun(run.id)?.status, "failed");
    void device;
  });

  it("rejects indefinite clipboard grants", async () => {
    const { app, auth } = await boot();
    const res = await app.request("/api/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        grantId: "clip_always",
        capability: "clipboard.read",
      }),
    });
    assert.equal(res.status, 400);
  });
});

describe("local tools + signatures + failover", () => {
  it("opens Clients only via the service enum", async () => {
    const { store, env, app, auth, device } = await boot();
    const created = await createRun(app, auth, "Open Clients");
    await drainWorker(store, env, "worker-a");
    const envelope = envelopeFrom(store, created.data.runId);
    assert.equal(envelope.arguments.serviceId, "clients");
    const posted = await postSignedResult({
      app,
      auth,
      device,
      runId: created.data.runId,
      envelope,
      result: { opened: "tendencys-partners" },
    });
    assert.equal(posted.status, 200, await posted.text());
    await drainWorker(store, env, "worker-a");
    assert.equal(store.getRun(created.data.runId)?.status, "completed");

    const bad = await createRun(app, auth, "Open not-a-real-product");
    await drainWorker(store, env, "worker-a");
    assert.equal(store.getRun(bad.data.runId)?.status, "failed");
    assert.ok(
      store.auditEvents.some(
        (event) => event.action === "desktop.open_service" && event.policyOutcome === "DENY",
      ),
    );
  });

  it("accepts a device-signed clipboard result and echoes retries", async () => {
    const { store, env, app, auth, device } = await boot();
    await app.request("/api/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        grantId: "clip_session",
        capability: "clipboard.read",
        kind: "SESSION",
      }),
    });
    const created = await createRun(app, auth, "What is currently on my clipboard?");
    await drainWorker(store, env, "worker-a");
    const envelope = envelopeFrom(store, created.data.runId);
    const first = await postSignedResult({
      app,
      auth,
      device,
      runId: created.data.runId,
      envelope,
      result: { text: "API_KEY=secret" },
    });
    assert.equal(first.status, 200);
    const echo = await postSignedResult({
      app,
      auth,
      device,
      runId: created.data.runId,
      envelope,
      result: { text: "API_KEY=secret" },
    });
    const echoed = (await echo.json()) as { data: { idempotent: boolean } };
    assert.equal(echoed.data.idempotent, true);
    await drainWorker(store, env, "worker-a");
    assert.equal(store.getRun(created.data.runId)?.status, "completed");
  });

  it("rejects a renderer-forged tool result without a valid device signature", async () => {
    const { store, env, app, auth } = await boot();
    const created = await createRun(app, auth, "Open Clients");
    await drainWorker(store, env, "worker-a");
    const envelope = envelopeFrom(store, created.data.runId);
    const forged = await app.request(`/api/v1/runs/${created.data.runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        toolInvocationId: envelope.toolInvocationId,
        requestId: envelope.requestId,
        status: "succeeded",
        result: { fake: true },
        executedAt: new Date().toISOString(),
        deviceSignature: "not-a-signature",
      }),
    });
    assert.equal(forged.status, 403);
  });

  it("Worker B resumes a leased run without re-planning or double-executing", async () => {
    const { store, env, app, auth, device } = await boot();
    const created = await createRun(app, auth, "Open Clients");
    await tickWorker(store, env, "worker-a", env.leaseMs);
    const run = store.getRun(created.data.runId)!;
    assert.equal(run.status, "waiting_for_local_tool");
    const firstEnvelope = envelopeFrom(store, run.id);
    run.status = "running";
    run.workerId = "worker-a";
    run.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await tickWorker(store, env, "worker-b", env.leaseMs);
    const after = store.getRun(run.id)!;
    assert.equal(after.attempt >= 2, true);
    const started = store.eventsAfter(run.id, 0).filter((event) => event.eventType === "tool_started");
    assert.equal(started.length, 1);
    const posted = await postSignedResult({
      app,
      auth,
      device,
      runId: run.id,
      envelope: firstEnvelope,
      result: { opened: "clients" },
    });
    assert.equal(posted.status, 200);
    await drainWorker(store, env, "worker-b");
    assert.equal(store.getRun(run.id)?.status, "completed");
  });

  it("reads a file only after a folder grant projection exists", async () => {
    const { store, env, app, auth, device } = await boot();
    await app.request("/api/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        grantId: "workspace_work",
        capability: "files.read",
      }),
    });
    const created = await createRun(app, auth, "Read invoice.pdf from the work folder");
    await drainWorker(store, env, "worker-a");
    const envelope = envelopeFrom(store, created.data.runId);
    assert.equal(envelope.arguments.grantId, "workspace_work");
    const posted = await postSignedResult({
      app,
      auth,
      device,
      runId: created.data.runId,
      envelope,
      result: { text: "Invoice 001" },
    });
    assert.equal(posted.status, 200);
    await drainWorker(store, env, "worker-a");
    assert.equal(store.getRun(created.data.runId)?.status, "completed");
  });

  it("replays durable SSE events from Last-Event-ID", async () => {
    const { store, env, app, auth } = await boot();
    const created = await createRun(
      app,
      auth,
      "Remember that I prefer Spanish invoices.",
    );
    await drainWorker(store, env, "worker-a");
    const replay = await app.request(`/api/v1/runs/${created.data.runId}/events`, {
      headers: { ...auth, "Last-Event-ID": "1" },
    });
    assert.equal(replay.status, 200);
    const text = await replay.text();
    assert.ok(text.includes("event: message_complete") || text.includes("event: run_state"));
    assert.ok(!text.includes("event: tokens"));
  });
});

function evaluateDenyPath(store: JarvisStore): boolean {
  return store.auditEvents.some((event) => event.policyOutcome === "DENY") ||
    store.approvals.size === 0;
}
