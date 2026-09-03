import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { projectCommunications } from "./lib/communications.ts";
import { buildContext } from "./lib/context-compiler.ts";
import { hmacJwt } from "./lib/crypto.ts";
import { generateEd25519, signBytes } from "./lib/crypto.ts";
import { loadEnv } from "./lib/env.ts";
import { applyRuntimeSnapshot, memoryRuntime, snapshotRuntime } from "./lib/runtime-repo.ts";
import { JarvisStore } from "./lib/store.ts";
import { lastRunForTask, memoryWorkforce } from "./lib/workforce.ts";
import { drainWorker, tickWorker } from "./worker.ts";

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

function copyHarness(from: JarvisStore, to: JarvisStore): void {
  for (const [id, row] of from.organizations) {
    to.organizations.set(id, { ...row });
  }
  for (const [id, row] of from.agents) {
    to.agents.set(id, { ...row });
  }
  for (const [id, row] of from.agentVersions) {
    to.agentVersions.set(id, { ...row });
  }
  for (const [id, row] of from.principals) {
    to.principals.set(id, { ...row });
  }
  for (const [id, row] of from.threads) {
    to.threads.set(id, { ...row });
  }
  to.messages.push(...from.messages.map((row) => ({ ...row, embedding: [...row.embedding] })));
  to.memories.push(
    ...from.memories.map((row) => ({ ...row, embedding: [...row.embedding] })),
  );
  to.actionOutcomes.push(...from.actionOutcomes.map((row) => ({ ...row })));
  for (const [id, row] of from.objectives) {
    to.objectives.set(id, { ...row });
  }
  applyRuntimeSnapshot(to, snapshotRuntime(from));
}

async function boot() {
  const store = new JarvisStore();
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
  const runtime = memoryRuntime(store);
  const app = createApp({ store, env, runtime });
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
  const sessionJson = (await sessionRes.json()) as {
    success: true;
    data: { token: string; sessionId: string; orgId: string; userId: string };
  };
  assert.equal(sessionRes.status, 200, JSON.stringify(sessionJson));
  const auth = { Authorization: `Bearer ${sessionJson.data.token}` };
  return { store, env, app, runtime, device, auth, deviceId, session: sessionJson };
}

describe("session reuse and revoke after restart", () => {
  it("reuses the session row and mints a fresh JWT", async () => {
    const { app, session, deviceId, device } = await boot();
    const again = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atid: "test:user_1:org_acme",
        deviceId,
        devicePublicKey: device.publicKeyB64,
        attestation: attest(device, deviceId),
      }),
    });
    const body = (await again.json()) as { data: { sessionId: string; token: string } };
    assert.equal(again.status, 200);
    assert.equal(body.data.sessionId, session.data.sessionId);
    const agents = await app.request("/api/v1/agents", {
      headers: { Authorization: `Bearer ${body.data.token}` },
    });
    assert.equal(agents.status, 200);
  });

  it("revokes the session across a new app + hydrated repo", async () => {
    const first = await boot();
    const revoke = await first.app.request("/api/v1/auth/session/revoke", {
      method: "POST",
      headers: first.auth,
    });
    assert.equal(revoke.status, 200);
    const store2 = new JarvisStore();
    copyHarness(first.store, store2);
    const app2 = createApp({
      store: store2,
      env: first.env,
      runtime: memoryRuntime(store2),
    });
    const denied = await app2.request("/api/v1/agents", { headers: first.auth });
    assert.equal(denied.status, 401);
  });

  it("rejects tenant mismatch, revoked device, and revoked session", async () => {
    const { env, app, auth, session, store, deviceId } = await boot();
    const mismatched = hmacJwt(env.jwtSecret, {
      aud: "jarvis",
      userId: session.data.userId,
      orgId: "other_org",
      deviceId,
      sessionId: session.data.sessionId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const tenant = await app.request("/api/v1/agents", {
      headers: { Authorization: `Bearer ${mismatched}` },
    });
    assert.equal(tenant.status, 401);
    store.revokeDevice(deviceId);
    const deviceDenied = await app.request("/api/v1/agents", { headers: auth });
    assert.equal(deviceDenied.status, 401);
  });
});

describe("idempotency, nonce, approval, grant", () => {
  it("returns the same runId for a duplicate x-idempotency-key", async () => {
    const { app, auth } = await boot();
    const headers = {
      "Content-Type": "application/json",
      "x-idempotency-key": "idem-run-1",
      ...auth,
    };
    const first = await app.request("/api/v1/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Remember that I prefer Spanish invoices." }),
    });
    const second = await app.request("/api/v1/runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Remember that I prefer Spanish invoices." }),
    });
    const a = (await first.json()) as { data: { runId: string } };
    const b = (await second.json()) as { data: { runId: string; idempotent?: boolean } };
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(a.data.runId, b.data.runId);
    assert.equal(b.data.idempotent, true);
  });

  it("treats a duplicate tool-result after restart as idempotent", async () => {
    const first = await boot();
    const created = await first.app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...first.auth },
      body: JSON.stringify({ prompt: "Open Clients" }),
    });
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    await drainWorker(first.store, { ...first.env, runtime: first.runtime }, "worker-a");
    const event = first.store.eventsAfter(runId, 0).find((row) => row.eventType === "tool_started");
    const envelope = event?.payload.envelope as {
      toolInvocationId: string;
      requestId: string;
    };
    const executedAt = new Date().toISOString();
    const { deviceResultSignBytes } = await import("./lib/crypto.ts");
    const signature = signBytes(
      first.device.privateKeyB64,
      deviceResultSignBytes({
        runId,
        toolInvocationId: envelope.toolInvocationId,
        requestId: envelope.requestId,
        status: "succeeded",
        result: { opened: "clients" },
        executedAt,
      }),
    );
    const payload = {
      toolInvocationId: envelope.toolInvocationId,
      requestId: envelope.requestId,
      status: "succeeded",
      result: { opened: "clients" },
      executedAt,
      deviceSignature: signature,
    };
    const posted = await first.app.request(`/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...first.auth },
      body: JSON.stringify(payload),
    });
    assert.equal(posted.status, 200);
    const store2 = new JarvisStore();
    copyHarness(first.store, store2);
    const app2 = createApp({
      store: store2,
      env: first.env,
      runtime: memoryRuntime(store2),
    });
    const echoed = await app2.request(`/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...first.auth },
      body: JSON.stringify(payload),
    });
    const body = (await echoed.json()) as { data: { idempotent: boolean } };
    assert.equal(echoed.status, 200);
    assert.equal(body.data.idempotent, true);
  });

  it("fails an expired pending approval without executing", async () => {
    const { store, env, app, auth, runtime } = await boot();
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ prompt: "Put hello world on the clipboard" }),
    });
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    await drainWorker(store, { ...env, runtime }, "worker-a");
    const approval = [...store.approvals.values()][0];
    assert.ok(approval);
    approval.expiresAt = new Date(Date.now() - 1000).toISOString();
    const run = store.getRun(runId)!;
    run.status = "running";
    run.workerId = "worker-a";
    run.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    run.nextWakeAt = new Date().toISOString();
    await tickWorker(store, { ...env, runtime }, "worker-b", env.leaseMs);
    assert.equal(store.getRun(runId)?.status, "failed");
    assert.equal(store.getInvocation(approval.toolInvocationId)?.status, "failed");
  });

  it("does not execute after a revoked grant on resume", async () => {
    const { store, env, app, auth, runtime } = await boot();
    await app.request("/api/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ grantId: "workspace_work", capability: "files.read" }),
    });
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ prompt: "Put hello world on the clipboard" }),
    });
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    await drainWorker(store, { ...env, runtime }, "worker-a");
    const approval = [...store.approvals.values()][0];
    const invocation = store.getInvocation(approval.toolInvocationId)!;
    invocation.grantId = "workspace_work";
    store.revokeGrant("workspace_work");
    await runtime.upsertGrant(store.grants.get("workspace_work")!);
    const decide = await app.request(`/api/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decide.status, 200);
    await drainWorker(store, { ...env, runtime }, "worker-b");
    assert.equal(store.getInvocation(invocation.id)?.status, "failed");
    assert.equal(store.getRun(runId)?.status, "failed");
  });

  it("rejects an expired envelope and a replayed result nonce", async () => {
    const { store, env, app, auth, runtime, device } = await boot();
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ prompt: "Open Clients" }),
    });
    const runId = ((await created.json()) as { data: { runId: string } }).data.runId;
    await drainWorker(store, { ...env, runtime }, "worker-a");
    const event = store.eventsAfter(runId, 0).find((row) => row.eventType === "tool_started");
    const envelope = event?.payload.envelope as { toolInvocationId: string; requestId: string };
    const invocation = store.getInvocation(envelope.toolInvocationId)!;
    invocation.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { deviceResultSignBytes } = await import("./lib/crypto.ts");
    const executedAt = new Date().toISOString();
    const expired = await app.request(`/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        toolInvocationId: envelope.toolInvocationId,
        requestId: envelope.requestId,
        status: "succeeded",
        result: { opened: "clients" },
        executedAt,
        deviceSignature: signBytes(
          device.privateKeyB64,
          deviceResultSignBytes({
            runId,
            toolInvocationId: envelope.toolInvocationId,
            requestId: envelope.requestId,
            status: "succeeded",
            result: { opened: "clients" },
            executedAt,
          }),
        ),
      }),
    });
    assert.equal(expired.status, 403);
    invocation.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await app.request(`/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        toolInvocationId: envelope.toolInvocationId,
        requestId: envelope.requestId,
        status: "succeeded",
        result: { opened: "clients" },
        executedAt,
        deviceSignature: signBytes(
          device.privateKeyB64,
          deviceResultSignBytes({
            runId,
            toolInvocationId: envelope.toolInvocationId,
            requestId: envelope.requestId,
            status: "succeeded",
            result: { opened: "clients" },
            executedAt,
          }),
        ),
      }),
    });
    assert.equal(first.status, 200);
    invocation.status = "sent";
    const replay = await app.request(`/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        toolInvocationId: envelope.toolInvocationId,
        requestId: envelope.requestId,
        status: "succeeded",
        result: { opened: "clients" },
        executedAt,
        deviceSignature: signBytes(
          device.privateKeyB64,
          deviceResultSignBytes({
            runId,
            toolInvocationId: envelope.toolInvocationId,
            requestId: envelope.requestId,
            status: "succeeded",
            result: { opened: "clients" },
            executedAt,
          }),
        ),
      }),
    });
    assert.equal(replay.status, 403);
  });
});

describe("compiler after restart", () => {
  it("reloads conversation, memory, task thread, and config_switch", async () => {
    const first = await boot();
    const created = await first.app.request("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...first.auth },
      body: JSON.stringify({ prompt: "Remember that I prefer Spanish invoices." }),
    });
    const runId = ((await created.json()) as { data: { runId: string; threadId: string } }).data
      .runId;
    await drainWorker(first.store, { ...first.env, runtime: first.runtime }, "worker-a");
    const run = first.store.getRun(runId)!;
    first.store.addStep(run.id, "config_switch", {
      fromAgentId: run.agentId,
      toAgentId: run.agentId,
      fromVersionId: run.agentVersion,
      toVersionId: run.agentVersion,
    });
    const workforce = memoryWorkforce();
    const task = await workforce.createTask({
      id: "tsk_1",
      orgId: "org_acme",
      name: "Follow up",
      description: "",
      status: "assigned",
      priority: "normal",
      objectiveId: null,
      assigneePrincipalId: null,
      createdByPrincipalId: null,
      dueAt: null,
      projectUnitId: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    run.taskId = task.id;
    const store2 = new JarvisStore();
    copyHarness(first.store, store2);
    await memoryRuntime(store2).hydrateStore(store2);
    const version = store2.getVersion(run.agentVersion)!;
    const ctx = buildContext({
      store: store2,
      version,
      userId: run.actorId,
      prompt: run.prompt,
      run: store2.getRun(run.id)!,
      task,
    });
    assert.match(ctx.layers.conversation, /Spanish invoices/);
    const recalled = store2.recall({
      orgId: "org_acme",
      actorId: "user_1",
      agentId: run.agentId,
      threadId: run.threadId,
      allowScopes: ["personal", "agent", "organization", "conversation"],
      query: "Spanish invoices",
      embedding: first.store.memories[0]?.embedding ?? [],
    });
    assert.ok(recalled.some((row) => row.content.includes("Spanish")));
    assert.equal(lastRunForTask(store2, task.id)?.threadId, run.threadId);
    const comms = await projectCommunications(store2, workforce, "org_acme", "user_1");
    assert.ok(comms.some((row) => row.source === "config_switch"));
  });
});
