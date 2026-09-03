import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { attachConnector, removeConnector, updateConnector, verifyWebhook } from "./lib/connectors.ts";
import {
  bindOauthState,
  buildAuthorizeUrl,
  completeConnect,
  connectSessionByOauthState,
  exchangeOauthToken,
  listIntegrations,
  startConnect,
} from "./lib/integrations.ts";
import { findProviderByAlias, CUSTOM_PROVIDER } from "./lib/providers.ts";
import { deviceResultSignBytes, openSecret, sealSecret, verifyBytes } from "./lib/crypto.ts";
import { saveCustomTool } from "./lib/custom-tools.ts";
import { AppError, ok, validationError, notFound, conflict, forbidden, unauthorized } from "./lib/errors.ts";
import type { ConnectorFetch, LookupFn } from "./lib/connectors.ts";
import type { JarvisEnv } from "./lib/env.ts";
import { assertGrantKind, clipboardExpiresAt, isClipboardCapability } from "./lib/grants.ts";
import { id } from "./lib/ids.ts";
import {
  issueAccessToken,
  requireAuth,
  resolveAccountsIdentity,
  verifyAttestation,
} from "./lib/session.ts";
import type { JarvisStore } from "./lib/store.ts";
import {
  buildGraphView,
  createUnit,
  deleteRelationship,
  deleteUnit,
  endProject,
  replaceReportsTo,
  updateUnit,
  writeRelationship,
} from "./lib/org-graph.ts";
import { applyAutonomyPreset, capabilityGaps } from "./lib/studio-access.ts";
import { compileAgentFromGraph, compileAgentsTouchedBySkillEdge, ensureDefaultDesktopTools } from "./lib/studio-compile.ts";
import {
  createStudioProposal,
  instantiateProposal,
  patchStudioProposal,
  STUDIO_TEMPLATES,
} from "./lib/studio-propose.ts";
import { parseHandlePrefix } from "./lib/handles.ts";
import { activityForAgent } from "./lib/agent-activity.ts";
import { projectCommunications } from "./lib/communications.ts";
import {
  persistConnectSession,
  persistConnectorHealth,
  persistDraft,
  persistGraphWrite,
  persistOrgSnapshot,
  persistRecipe,
  persistThreadWrite,
} from "./lib/persist.ts";
import { recommendConnection } from "./lib/recipes.ts";
import {
  addSource,
  answer as answerDraft,
  createDraft,
  discover,
  propose,
  register as registerDraft,
} from "./lib/integration-engineer.ts";
import { validateDraft } from "./lib/integration-validator.ts";
import { memoryRuntime, type RuntimeRepo } from "./lib/runtime-repo.ts";
import { DEFAULT_JARVIS_TOOLS } from "./lib/tools.ts";
import { finishRun } from "./lib/runtime.ts";
import { drainWorker } from "./worker.ts";
import type { MemoryScope, ModelTier, TaskPriority, TaskStatus } from "./lib/types.ts";
import {
  assignTask,
  createObjectiveRecord,
  createTaskRecord,
  inboxForOrg,
  memoryWorkforce,
  recordTaskEvent,
  retryTask,
  startTask,
  type WorkforceRepo,
} from "./lib/workforce.ts";

export type AppDeps = {
  store: JarvisStore;
  env: JarvisEnv;
  workforce?: WorkforceRepo;
  runtime?: RuntimeRepo;
  fetch?: ConnectorFetch;
  lookup?: LookupFn;
};

const sessionBody = z.object({
  atid: z.string().min(1),
  deviceId: z.string().min(1),
  devicePublicKey: z.string().min(1),
  attestation: z.string().min(1),
  deviceName: z.string().optional(),
  accountsBaseUrl: z.string().url().optional(),
});

const runBody = z.object({
  prompt: z.string().min(1),
  threadId: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
});

const taskPriority = z.enum(["low", "normal", "high", "urgent"]);
const taskStatus = z.enum([
  "planned",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);

const toolResultBody = z.object({
  toolInvocationId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.enum(["success", "succeeded", "failed"]),
  result: z.unknown(),
  executedAt: z.string().min(1),
  deviceSignature: z.string().min(1),
});

const approvalBody = z.object({
  decision: z.enum(["approved", "rejected"]),
});

const agentBody = z.object({
  name: z.string().min(1),
  identity: z.string().min(1),
  jobs: z.string().min(1),
  toolIds: z.array(z.string()).default(DEFAULT_JARVIS_TOOLS),
  memoryPolicy: z
    .object({
      allowScopes: z.array(
        z.enum(["personal", "agent", "organization", "conversation"]),
      ),
    })
    .default({
      allowScopes: ["personal", "agent", "organization", "conversation"],
    }),
  modelTier: z.enum(["sol", "terra", "luna"]).default("sol"),
});

const grantBody = z.object({
  grantId: z.string().min(1),
  capability: z.string().min(1),
  kind: z.enum(["ONCE", "SESSION", "15_MIN"]).optional(),
  expiresAt: z.string().nullable().optional(),
});

const bulkItems = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item).min(1).max(500) });

const proposalBody = z.object({
  brief: z.string().min(1),
  templateId: z.string().optional(),
});

const proposalPatchBody = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string(),
        refId: z.string(),
      }),
    )
    .optional(),
  edges: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        fromId: z.string(),
        toId: z.string(),
        sourceTable: z.string(),
      }),
    )
    .optional(),
});

const relationshipItem = z.object({
  kind: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
});

function studioSnapshot(
  store: JarvisStore,
  orgId: string,
  userId: string,
  displayName: string,
) {
  store.ensureHumanPrincipal(orgId, userId, displayName);
  store.seedDefaultJarvis(orgId);
  const org = store.getOrg(orgId)!;
  const graph = buildGraphView(store, orgId);
  return {
    org: { companyId: org.companyId, name: org.name, graphRevision: org.graphRevision },
    graphRevision: org.graphRevision,
    nodes: graph.nodes,
    edges: graph.edges,
    gaps: capabilityGaps(store, orgId),
    connectors: store.connectorsFor(orgId).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      revision: row.revision,
      purpose: row.publicConfig.purpose ?? null,
      origin: row.publicConfig.origin,
    })),
    customTools: [...store.customTools.values()]
      .filter((row) => row.orgId === orgId)
      .map((row) => ({
        id: row.id,
        toolId: row.toolId,
        risk: row.risk,
        steps: row.definition.steps.length,
      })),
  };
}

function jsonError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return validationError("Invalid body", error.flatten());
  }
  if (error instanceof Error) {
    return validationError(error.message);
  }
  return new AppError("INTERNAL_ERROR", "Unexpected error", 500);
}

export function createApp(deps: AppDeps) {
  const { store, env } = deps;
  const workforce = deps.workforce ?? memoryWorkforce();
  const runtime = deps.runtime ?? memoryRuntime(store);
  const workerKeys = { ...env, workforce, runtime, fetch: deps.fetch, lookup: deps.lookup };
  async function persistCreatedRun(runId: string | null | undefined): Promise<void> {
    if (!runId) {
      return;
    }
    const run = store.getRun(runId);
    if (run) {
      await runtime.upsertRun(run);
    }
  }
  const app = new Hono();

  app.onError((error, c) => {
    const mapped = jsonError(error);
    return c.json(mapped.toJSON(), mapped.status as 400);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/v1/health", (c) =>
    c.json(
      ok({
        ok: true,
        serverPublicKey: env.serverPublicKeyB64,
      }),
    ),
  );

  app.post("/api/v1/auth/session", async (c) => {
    const body = sessionBody.parse(await c.req.json());
    if (!verifyAttestation(body)) {
      throw forbidden("invalid device attestation");
    }
    const identity = await resolveAccountsIdentity(env, body.atid, {
      accountsBaseUrl: body.accountsBaseUrl,
    });
    const orgExisted = store.organizations.has(identity.orgId);
    const jarvisExisted = Boolean(store.findAgentByName(identity.orgId, "Jarvis"));
    store.ensureOrg(identity.orgId, identity.userId);
    store.seedDefaultJarvis(identity.orgId);
    ensureDefaultDesktopTools(store, identity.orgId);
    if (!orgExisted || !jarvisExisted) {
      const org = store.organizations.get(identity.orgId);
      if (org) {
        await store.persist("organizations", org);
      }
      for (const agent of store.listAgents(identity.orgId)) {
        await store.persist("agents", agent);
        const version = store.latestVersion(agent.id);
        if (version) {
          await store.persist("agent_versions", version);
        }
      }
      for (const grant of store.accessGrants.values()) {
        if (grant.orgId === identity.orgId) {
          await store.persist("access_grants", grant);
        }
      }
    }
    const existingDevice = store.devices.get(body.deviceId);
    const existingKey = existingDevice?.publicKey;
    const device = store.upsertDevice({
      id: body.deviceId,
      userId: identity.userId,
      orgId: identity.orgId,
      publicKey: body.devicePublicKey,
      name: body.deviceName ?? "desktop",
    });
    if (!existingDevice || existingKey !== device.publicKey) {
      await runtime.upsertDevice(device);
    }
    const reusable = await runtime.findReusableSession(device.id);
    const session = reusable ?? store.createSession({
      userId: identity.userId,
      orgId: identity.orgId,
      deviceId: device.id,
      ttlMs: env.sessionTtlMs,
    });
    if (reusable) {
      session.expiresAt = new Date(Date.now() + env.sessionTtlMs).toISOString();
      session.lastSeenAt = new Date().toISOString();
    } else {
      await runtime.upsertSession(session);
    }
    const access = issueAccessToken(env, {
      userId: identity.userId,
      orgId: identity.orgId,
      deviceId: device.id,
      sessionId: session.id,
    });
    return c.json(
      ok({
        token: access.token,
        expiresAt: access.expiresAt,
        sessionId: session.id,
        userId: identity.userId,
        orgId: identity.orgId,
        deviceId: device.id,
        serverPublicKey: env.serverPublicKeyB64,
      }),
    );
  });

  app.post("/api/v1/auth/session/revoke", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    await runtime.revokeSession(auth.sessionId);
    return c.json(ok({ revoked: true, sessionId: auth.sessionId }));
  });

  app.get("/api/v1/agents", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const agents = store.listAgents(auth.orgId).map((agent) => ({
      ...agent,
      latestVersion: store.latestVersion(agent.id),
      activity: activityForAgent(store, agent.id),
    }));
    return c.json(ok({ items: agents }));
  });

  app.get("/api/v1/principals", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    const items = [...store.principals.values()]
      .filter((row) => row.orgId === auth.orgId)
      .map((row) => ({
        id: row.id,
        type: row.type,
        displayName: row.displayName,
        agentId: row.agentId,
        handle: row.agentId ? store.agents.get(row.agentId)?.handle ?? null : null,
      }));
    return c.json(ok({ items }));
  });

  app.post("/api/v1/agents", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = agentBody.parse(await c.req.json());
    const created = store.createAgent({
      orgId: auth.orgId,
      name: body.name,
      identity: body.identity,
      jobs: body.jobs,
      toolIds: body.toolIds,
      memoryPolicy: body.memoryPolicy,
      modelTier: body.modelTier as ModelTier,
    });
    store.bumpGraphRevision(auth.orgId);
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok(created), 201);
  });

  app.post("/api/v1/agents/:agentId/versions", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const agent = store.agents.get(c.req.param("agentId"));
    if (!agent || agent.orgId !== auth.orgId) {
      throw notFound("Agent");
    }
    const body = agentBody.omit({ name: true }).parse(await c.req.json());
    const version = store.addAgentVersion(agent.id, {
      identity: body.identity,
      jobs: body.jobs,
      toolIds: body.toolIds,
      memoryPolicy: body.memoryPolicy,
      modelTier: body.modelTier as ModelTier,
    });
    return c.json(ok({ agent, version }), 201);
  });

  app.get("/api/v1/threads", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const items = store.listThreads(auth.orgId, auth.userId).map((thread) => ({
      ...thread,
      messages: store.messagesFor(thread.id).slice(-50),
    }));
    return c.json(ok({ items }));
  });

  app.get("/api/v1/memories", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const items = store.memories.filter((memory) => {
      if (memory.orgId !== auth.orgId) {
        return false;
      }
      if (memory.scopeType === "personal") {
        return memory.subjectUserId === auth.userId;
      }
      return true;
    });
    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return c.json(ok({ items }));
  });

  app.get("/api/v1/communications", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const items = await projectCommunications(store, workforce, auth.orgId, auth.userId);
    return c.json(ok({ items }));
  });

  app.post("/api/v1/grants", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = grantBody.parse(await c.req.json());
    assertGrantKind(body.capability, body.kind);
    const session = store.getSession(auth.sessionId)!;
    const expiresAt = isClipboardCapability(body.capability)
      ? clipboardExpiresAt(body.kind!, session.expiresAt)
      : (body.expiresAt ?? null);
    const grant = store.upsertGrant({
      grantId: body.grantId,
      orgId: auth.orgId,
      deviceId: auth.deviceId,
      capability: body.capability,
      expiresAt,
      revokedAt: null,
    });
    await runtime.upsertGrant(grant);
    return c.json(ok({ grant }));
  });

  app.post("/api/v1/grants/:grantId/revoke", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const grant = store.grants.get(c.req.param("grantId"));
    if (!grant || grant.orgId !== auth.orgId || grant.deviceId !== auth.deviceId) {
      throw notFound("Grant");
    }
    store.revokeGrant(grant.grantId);
    const revoked = store.grants.get(grant.grantId);
    if (revoked) {
      await runtime.upsertGrant(revoked);
    }
    return c.json(ok({ grant: revoked ?? grant }));
  });

  app.post("/api/v1/runs", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const idemKey = c.req.header("x-idempotency-key")?.trim();
    if (idemKey) {
      const cached = await runtime.getIdempotency(idemKey, "runs.create");
      if (cached && typeof cached === "object") {
        return c.json(ok({ ...(cached as Record<string, unknown>), idempotent: true }));
      }
    }
    const body = runBody.parse(await c.req.json());
    const seeded = store.seedDefaultJarvis(auth.orgId);
    const mentioned = parseHandlePrefix(body.prompt);
    const fromHandle = mentioned
      ? store.resolveAgent(auth.orgId, mentioned.handle)
      : undefined;
    if (mentioned && !fromHandle && !body.agentId) {
      const thread = body.threadId
        ? store.threads.get(body.threadId)
        : store.createThread({
            orgId: auth.orgId,
            actorId: auth.userId,
            agentId: seeded.agent.id,
            title: body.prompt.slice(0, 80),
          });
      if (!thread || thread.orgId !== auth.orgId || thread.actorId !== auth.userId) {
        throw notFound("Thread");
      }
      const userMessage = store.addMessage(thread.id, "user", body.prompt);
      await persistThreadWrite(store, thread.id, userMessage);
      const version = store.latestVersion(seeded.agent.id);
      if (!version) {
        throw notFound("Agent version");
      }
      const run = store.createRun({
        id: id("run"),
        orgId: auth.orgId,
        actorId: auth.userId,
        threadId: thread.id,
        agentId: seeded.agent.id,
        agentVersion: version.id,
        sessionId: auth.sessionId,
        deviceId: auth.deviceId,
        prompt: body.prompt,
        taskId: body.taskId ?? null,
      });
      await runtime.upsertRun(run);
      await finishRun(
        store,
        run,
        workerKeys,
        undefined,
        `No agent @${mentioned.handle}. Add them in Studio, or retry as @jarvis.`,
      );
      const payload = { runId: run.id, threadId: thread.id, status: store.getRun(run.id)?.status ?? "completed" };
      if (idemKey) {
        await runtime.storeIdempotency(idemKey, "runs.create", payload, 24 * 60 * 60_000);
      }
      return c.json(ok(payload), 201);
    }
    const agent = body.agentId
      ? store.agents.get(body.agentId)
      : (fromHandle ?? seeded.agent);
    if (!agent || agent.orgId !== auth.orgId) {
      throw notFound("Agent");
    }
    const version = store.latestVersion(agent.id);
    if (!version) {
      throw notFound("Agent version");
    }
    const thread = body.threadId
      ? store.threads.get(body.threadId)
      : store.createThread({
          orgId: auth.orgId,
          actorId: auth.userId,
          agentId: agent.id,
          title: body.prompt.slice(0, 80),
        });
    if (!thread || thread.orgId !== auth.orgId || thread.actorId !== auth.userId) {
      throw notFound("Thread");
    }
    const userMessage = store.addMessage(thread.id, "user", body.prompt);
    await persistThreadWrite(store, thread.id, userMessage);
    const run = store.createRun({
      id: id("run"),
      orgId: auth.orgId,
      actorId: auth.userId,
      threadId: thread.id,
      agentId: agent.id,
      agentVersion: version.id,
      sessionId: auth.sessionId,
      deviceId: auth.deviceId,
      prompt: body.prompt,
      taskId: body.taskId ?? null,
    });
    await runtime.upsertRun(run);
    const payload = { runId: run.id, threadId: thread.id, status: run.status };
    if (idemKey) {
      await runtime.storeIdempotency(idemKey, "runs.create", payload, 24 * 60 * 60_000);
    }
    if (env.inlineWorker) {
      void drainWorker(store, workerKeys, "inline", env.leaseMs).catch((error) => {
        console.error("[jarvis/runs] inline worker failed", error);
      });
    }
    return c.json(ok(payload), 201);
  });

  app.get("/api/v1/runs/:runId", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const run = store.getRun(c.req.param("runId"));
    if (!run || run.orgId !== auth.orgId || run.actorId !== auth.userId) {
      throw notFound("Run");
    }
    return c.json(
      ok({
        run,
        steps: store.stepsFor(run.id),
        events: store.eventsAfter(run.id, 0),
      }),
    );
  });

  app.get("/api/v1/runs/:runId/events", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const run = store.getRun(c.req.param("runId"));
    if (!run || run.orgId !== auth.orgId || run.actorId !== auth.userId) {
      throw notFound("Run");
    }
    const last = Number(c.req.header("Last-Event-ID") ?? "0");
    return streamSSE(c, async (stream) => {
      let cursor = Number.isFinite(last) ? last : 0;
      for (const event of await runtime.eventsAfter(run.id, cursor)) {
        await stream.writeSSE({
          id: String(event.sequence),
          event: event.eventType,
          data: JSON.stringify(event.payload),
        });
        cursor = event.sequence;
      }
      for (let i = 0; i < 3_000; i += 1) {
        const latest = store.getRun(run.id) ?? (await runtime.getRun(run.id));
        for (const event of await runtime.eventsAfter(run.id, cursor)) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.eventType,
            data: JSON.stringify(event.payload),
          });
          cursor = event.sequence;
        }
        if (latest && (latest.status === "completed" || latest.status === "failed")) {
          return;
        }
        await stream.sleep(200);
      }
    });
  });

  app.post("/api/v1/runs/:runId/tool-results", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const run = store.getRun(c.req.param("runId"));
    if (!run || run.orgId !== auth.orgId) {
      throw notFound("Run");
    }
    const body = toolResultBody.parse(await c.req.json());
    const invocation = store.getInvocation(body.toolInvocationId);
    if (
      !invocation ||
      invocation.runId !== run.id ||
      invocation.sessionId !== auth.sessionId ||
      invocation.deviceId !== auth.deviceId ||
      invocation.requestId !== body.requestId
    ) {
      throw notFound("Tool invocation");
    }
    const device = store.devices.get(auth.deviceId);
    if (!device) {
      throw notFound("Device");
    }
    const wireStatus = body.status === "success" ? "succeeded" : body.status;
    const signed = verifyBytes(
      device.publicKey,
      deviceResultSignBytes({
        runId: run.id,
        toolInvocationId: invocation.id,
        requestId: body.requestId,
        status: body.status,
        result: body.result,
        executedAt: body.executedAt,
      }),
      body.deviceSignature,
    );
    if (!signed) {
      throw forbidden("invalid device signature");
    }
    if (invocation.status === "succeeded" || invocation.status === "failed") {
      return c.json(ok({ invocation, idempotent: true }));
    }
    if (invocation.expiresAt && Date.parse(invocation.expiresAt) < Date.now()) {
      throw forbidden("envelope expired");
    }
    if (invocation.nonce && !(await runtime.rememberNonce(`result:${invocation.nonce}`))) {
      throw forbidden("nonce replay");
    }
    if (invocation.status !== "sent") {
      throw conflict("invocation is not waiting");
    }
    store.completeInvocation(
      invocation.id,
      wireStatus === "failed" ? "failed" : "succeeded",
      body.result,
    );
    const completed = store.getInvocation(invocation.id);
    if (completed) {
      await runtime.upsertInvocation(completed);
    }
    if (invocation.grantId) {
      const grant = store.grants.get(invocation.grantId);
      if (grant && grant.capability === "clipboard.read") {
        const remaining = Date.parse(grant.expiresAt ?? "") - Date.now();
        if (remaining > 0 && remaining <= 5 * 60_000) {
          store.revokeGrant(grant.grantId);
          const revoked = store.grants.get(grant.grantId);
          if (revoked) {
            await runtime.upsertGrant(revoked);
          }
        }
      }
    }
    await runtime.wakeRun(run.id);
    if (env.inlineWorker) {
      await drainWorker(store, workerKeys, "inline", env.leaseMs);
    }
    return c.json(ok({ invocation, idempotent: false }));
  });

  app.post("/api/v1/approvals/:approvalId/decision", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const approval = store.getApproval(c.req.param("approvalId"));
    if (!approval) {
      throw notFound("Approval");
    }
    const run = store.getRun(approval.runId);
    if (!run || run.orgId !== auth.orgId || run.actorId !== auth.userId) {
      throw notFound("Approval");
    }
    const body = approvalBody.parse(await c.req.json());
    const decided = store.decideApproval(approval.id, body.decision);
    if (decided) {
      await runtime.upsertApproval(decided);
    }
    await runtime.wakeRun(run.id);
    if (env.inlineWorker) {
      await drainWorker(store, workerKeys, "inline", env.leaseMs);
    }
    return c.json(ok({ approval: decided }));
  });

  const connectCompleteBody = z.object({
    connectId: z.string().min(1),
    fields: z.record(z.string()).default({}),
    providerId: z.string().optional(),
  });

  const connectStartBody = z.object({
    product: z.string().optional(),
    purpose: z.string().optional(),
  });

  app.get("/api/v1/integrations", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    store.seedDefaultJarvis(auth.orgId);
    return c.json(ok(listIntegrations(store, auth.orgId, process.env)));
  });

  const integrationPatchBody = z
    .object({
      name: z.string().min(1).optional(),
      origin: z.string().url().optional(),
      secret: z.string().min(1).optional(),
    })
    .refine((row) => Boolean(row.name || row.origin || row.secret), { message: "nothing to update" });

  app.patch("/api/v1/integrations/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = integrationPatchBody.parse(await c.req.json());
    try {
      const connector = updateConnector(
        store,
        { vaultKey: env.vaultKey, vaultKeyPrevious: env.vaultKeyPrevious },
        { orgId: auth.orgId, connectorId: c.req.param("id"), ...body },
      );
      await persistOrgSnapshot(store, auth.orgId);
      return c.json(ok({ connector: listIntegrations(store, auth.orgId).connectors.find((row) => row.id === connector.id) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_failed";
      if (message === "connector_missing") {
        throw notFound("Connector");
      }
      if (message === "egress_denied") {
        throw validationError("origin is not allowed");
      }
      throw err;
    }
  });

  app.delete("/api/v1/integrations/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    try {
      const connector = removeConnector(store, { orgId: auth.orgId, connectorId: c.req.param("id") });
      await persistOrgSnapshot(store, auth.orgId);
      await persistConnectorHealth(store, connector.id);
      return c.json(ok({ connectorId: connector.id, status: connector.status }));
    } catch (err) {
      if (err instanceof Error && err.message === "connector_missing") {
        throw notFound("Connector");
      }
      throw err;
    }
  });

  const recommendBody = z.object({
    product: z.string().optional(),
    purpose: z.string().optional(),
  });

  app.post("/api/v1/integrations/recommend", async (c) => {
    await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = recommendBody.parse(await c.req.json().catch(() => ({})));
    const recommendation = await recommendConnection(
      store,
      { product: body.product, purpose: body.purpose },
      {
        fetch: deps.fetch as typeof fetch | undefined,
        env: { modelApiKey: env.modelApiKey, modelBaseUrl: env.modelBaseUrl, modelName: env.modelName },
        oauthEnv: process.env,
      },
    );
    return c.json(ok(recommendation));
  });

  app.post("/api/v1/integrations/start", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = connectStartBody.parse(await c.req.json());
    const seeded = store.seedDefaultJarvis(auth.orgId);
    const result = startConnect(store, {
      orgId: auth.orgId,
      agentId: seeded.agent.id,
      createdBy: auth.userId,
      runId: null,
      product: body.product,
      purpose: body.purpose,
      env: process.env,
    });
    if ("connectId" in result) {
      await persistConnectSession(store, result.connectId);
    }
    return c.json(ok(result));
  });

  app.post("/api/v1/integrations/complete", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = connectCompleteBody.parse(await c.req.json());
    const session = store.connectSessions.get(body.connectId);
    if (!session || session.orgId !== auth.orgId || session.createdBy !== auth.userId) {
      throw notFound("Connect session");
    }
    const result = completeConnect(
      store,
      { vaultKey: env.vaultKey, vaultKeyPrevious: env.vaultKeyPrevious },
      { connectId: body.connectId, fields: body.fields, providerId: body.providerId },
    );
    await persistOrgSnapshot(store, auth.orgId);
    await persistConnectSession(store, body.connectId);
    if (result.provider && result.provider !== "custom") {
      await persistRecipe(store, result.provider);
    }
    if (session.runId) {
      await runtime.wakeRun(session.runId);
      if (env.inlineWorker) {
        await drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
    }
    return c.json(ok(result));
  });

  app.post("/api/v1/integrations/oauth/start", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = connectCompleteBody.parse(await c.req.json());
    const session = store.connectSessions.get(body.connectId);
    if (!session || session.orgId !== auth.orgId || session.createdBy !== auth.userId) {
      throw notFound("Connect session");
    }
    const spec = findProviderByAlias(body.providerId ?? session.providerId ?? "") ?? CUSTOM_PROVIDER;
    const state = bindOauthState(store, body.connectId, body.fields);
    await persistConnectSession(store, body.connectId);
    const redirectUri = `http://127.0.0.1:${env.port}/api/v1/integrations/oauth/callback`;
    const url = buildAuthorizeUrl({
      spec,
      env: process.env,
      redirectUri,
      state,
      fields: { ...session.fields, ...body.fields },
    });
    return c.json(ok({ url, state }));
  });

  app.get("/api/v1/integrations/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const session = connectSessionByOauthState(store, state);
    if (!session || !code) {
      return c.text("Connection failed. You can close this window.", 400);
    }
    const spec = findProviderByAlias(session.providerId ?? "") ?? CUSTOM_PROVIDER;
    const redirectUri = `http://127.0.0.1:${env.port}/api/v1/integrations/oauth/callback`;
    const token = await exchangeOauthToken({
      spec,
      env: process.env,
      redirectUri,
      code,
      fields: session.fields,
      fetchFn: deps.fetch,
    });
    const oauthResult = completeConnect(
      store,
      { vaultKey: env.vaultKey, vaultKeyPrevious: env.vaultKeyPrevious },
      { connectId: session.id, fields: session.fields, secret: token },
    );
    await persistOrgSnapshot(store, session.orgId);
    await persistConnectSession(store, session.id);
    if (oauthResult.provider && oauthResult.provider !== "custom") {
      await persistRecipe(store, oauthResult.provider);
    }
    if (session.runId) {
      await runtime.wakeRun(session.runId);
      if (env.inlineWorker) {
        await drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
    }
    return c.text("Connected. You can close this window.");
  });

  const engineerStartBody = z.object({ name: z.string().min(1) });
  const engineerSourceBody = z.object({
    type: z.enum([
      "openapi",
      "mcp",
      "documentation_url",
      "uploaded_documentation",
      "postman",
      "manual",
      "curl",
    ]),
    ref: z.string().optional(),
    content: z.string().optional(),
  });
  const engineerAnswerBody = z.object({
    baseUrl: z.string().optional(),
    authKind: z.enum(["bearer", "header_map", "basic"]).optional(),
  });
  const engineerApproveBody = z.object({
    secret: z.string().optional(),
    fields: z.record(z.string()).optional(),
  });
  const engineerValidateBody = z.object({
    secret: z.string().optional(),
    fields: z.record(z.string()).optional(),
  });

  function ownedDraft(orgId: string, draftId: string) {
    const draft = store.integrationDrafts.get(draftId);
    if (!draft || draft.orgId !== orgId) {
      throw notFound("Integration draft");
    }
    return draft;
  }

  app.get("/api/v1/integrations/engineer", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    return c.json(ok({ drafts: store.draftsFor(auth.orgId) }));
  });

  app.post("/api/v1/integrations/engineer", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = engineerStartBody.parse(await c.req.json());
    const draft = createDraft(store, { orgId: auth.orgId, createdBy: auth.userId, name: body.name });
    await persistDraft(store, draft.id);
    return c.json(ok({ draft }));
  });

  app.get("/api/v1/integrations/engineer/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    return c.json(ok({ draft, sources: store.sourcesForDraft(draft.id), validations: store.validationsForDraft(draft.id) }));
  });

  app.post("/api/v1/integrations/engineer/:id/source", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    const body = engineerSourceBody.parse(await c.req.json());
    addSource(store, draft, body);
    await discover(store, draft, { fetch: deps.fetch, lookup: deps.lookup });
    await persistDraft(store, draft.id);
    return c.json(ok({ draft }));
  });

  app.post("/api/v1/integrations/engineer/:id/answer", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    const body = engineerAnswerBody.parse(await c.req.json());
    answerDraft(draft, body);
    await persistDraft(store, draft.id);
    return c.json(ok({ draft }));
  });

  app.post("/api/v1/integrations/engineer/:id/propose", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    propose(draft);
    await persistDraft(store, draft.id);
    return c.json(ok({ draft }));
  });

  app.post("/api/v1/integrations/engineer/:id/validate", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    const body = engineerValidateBody.parse(await c.req.json().catch(() => ({})));
    const validations = await validateDraft(
      store,
      draft,
      { secret: body.secret, fields: body.fields },
      { fetch: deps.fetch, lookup: deps.lookup },
    );
    await persistDraft(store, draft.id);
    return c.json(ok({ draft, validations }));
  });

  app.post("/api/v1/integrations/engineer/:id/approve", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const draft = ownedDraft(auth.orgId, c.req.param("id"));
    const body = engineerApproveBody.parse(await c.req.json());
    const seeded = store.seedDefaultJarvis(auth.orgId);
    const result = registerDraft(
      store,
      { vaultKey: env.vaultKey, vaultKeyPrevious: env.vaultKeyPrevious },
      draft,
      { agentId: seeded.agent.id, createdBy: auth.userId, secret: body.secret, fields: body.fields },
    );
    await persistDraft(store, draft.id);
    await persistOrgSnapshot(store, auth.orgId);
    if (result.recipeSlug) {
      await persistRecipe(store, result.recipeSlug);
    }
    return c.json(ok({ draft, connectorId: result.connector.id, toolIds: result.toolIds }));
  });

  app.get("/api/v1/audit", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    return c.json(
      ok({
        items: store.auditEvents.filter((event) => event.orgId === auth.orgId),
      }),
    );
  });

  app.get("/api/v1/studio", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    return c.json(ok(studioSnapshot(store, auth.orgId, auth.userId, "Me")));
  });

  app.get("/api/v1/studio/templates", async (c) => {
    await requireAuth(runtime, env, c.req.header("Authorization"));
    return c.json(ok({ items: STUDIO_TEMPLATES.map((id) => ({ id })) }));
  });

  app.post("/api/v1/studio/proposals", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = proposalBody.parse(await c.req.json());
    store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    const proposal = createStudioProposal(store, {
      orgId: auth.orgId,
      createdBy: auth.userId,
      brief: body.brief,
      templateId: body.templateId,
      meLabel: "Me",
    });
    return c.json(ok({ proposal }), 201);
  });

  app.patch("/api/v1/studio/proposals/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const proposal = store.studioProposals.get(c.req.param("id"));
    if (!proposal || proposal.orgId !== auth.orgId) {
      throw notFound("Proposal");
    }
    const body = proposalPatchBody.parse(await c.req.json());
    const updated = patchStudioProposal(store, proposal.id, body);
    return c.json(ok({ proposal: updated }));
  });

  app.post("/api/v1/studio/proposals/:id/instantiate", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const proposal = store.studioProposals.get(c.req.param("id"));
    if (!proposal || proposal.orgId !== auth.orgId) {
      throw notFound("Proposal");
    }
    const result = instantiateProposal(store, proposal.id, {
      userId: auth.userId,
      displayName: "Me",
    });
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(
      ok({
        proposal: result.proposal,
        idempotent: result.idempotent,
        graph: result.graph,
        gaps: capabilityGaps(store, auth.orgId),
      }),
    );
  });

  app.post("/api/v1/studio/units", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(
      z.object({
        name: z.string().min(1),
        type: z.enum(["company", "department", "team", "project"]).default("department"),
        parentUnitId: z.string().nullable().optional(),
        startsAt: z.string().nullable().optional(),
        endsAt: z.string().nullable().optional(),
        status: z.string().optional(),
        objectiveId: z.string().nullable().optional(),
      }),
    ).parse(await c.req.json());
    const results = body.items.map((item) => {
      const unit = createUnit(store, {
        orgId: auth.orgId,
        name: item.name,
        type: item.type,
        parentUnitId: item.parentUnitId,
      });
      if (item.type === "project") {
        store.projectDetails.set(unit.id, {
          unitId: unit.id,
          startsAt: item.startsAt ?? null,
          endsAt: item.endsAt ?? null,
          status: item.status ?? "active",
          objectiveId: item.objectiveId ?? null,
        });
      }
      return { id: unit.id, status: "created" as const };
    });
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.patch("/api/v1/studio/units/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z
      .object({
        name: z.string().min(1).optional(),
        parentUnitId: z.string().nullable().optional(),
      })
      .parse(await c.req.json());
    const unit = updateUnit(store, auth.orgId, c.req.param("id"), body);
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ unit, graph: buildGraphView(store, auth.orgId) }));
  });

  app.delete("/api/v1/studio/units/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    deleteUnit(store, auth.orgId, c.req.param("id"));
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ graph: buildGraphView(store, auth.orgId) }));
  });

  app.patch("/api/v1/studio/principals/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z.object({ displayName: z.string().min(1) }).parse(await c.req.json());
    const principal = store.principals.get(c.req.param("id"));
    if (!principal || principal.orgId !== auth.orgId) {
      throw notFound("Principal");
    }
    principal.displayName = body.displayName;
    if (principal.agentId) {
      const agent = store.agents.get(principal.agentId);
      if (agent) {
        agent.name = body.displayName;
      }
    }
    store.bumpGraphRevision(auth.orgId);
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ principal, graph: buildGraphView(store, auth.orgId) }));
  });

  app.post("/api/v1/studio/roles", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(
      z.object({
        name: z.string().min(1),
        requiredToolIds: z.array(z.string()).default([]),
      }),
    ).parse(await c.req.json());
    const results = body.items.map((item) => {
      const role = {
        id: id("rol"),
        orgId: auth.orgId,
        name: item.name,
        requiredToolIds: item.requiredToolIds,
      };
      store.roles.set(role.id, role);
      store.bumpGraphRevision(auth.orgId);
      return { id: role.id, status: "created" as const };
    });
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.post("/api/v1/studio/skills", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(
      z.object({
        name: z.string().min(1),
        instructions: z.string().default(""),
        requiredTools: z.array(z.string()).default([]),
        requiredKnowledge: z.array(z.string()).default([]),
        inputSchema: z.record(z.unknown()).default({}),
        outputSchema: z.record(z.unknown()).default({}),
        evaluationPolicy: z.record(z.unknown()).default({}),
      }),
    ).parse(await c.req.json());
    const results = body.items.map((item) => {
      const skill = { id: id("skl"), orgId: auth.orgId, name: item.name };
      store.skills.set(skill.id, skill);
      const version = {
        id: id("skv"),
        skillId: skill.id,
        version: 1,
        instructions: item.instructions,
        inputSchema: item.inputSchema,
        outputSchema: item.outputSchema,
        requiredTools: item.requiredTools,
        requiredKnowledge: item.requiredKnowledge,
        evaluationPolicy: item.evaluationPolicy,
      };
      store.skillVersions.set(version.id, version);
      store.bumpGraphRevision(auth.orgId);
      return { id: skill.id, versionId: version.id, status: "created" as const };
    });
    await persistGraphWrite(store, auth.orgId);
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.post("/api/v1/studio/objectives", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(
      z.object({
        name: z.string().min(1),
        description: z.string().default(""),
      }),
    ).parse(await c.req.json());
    const results = [];
    for (const item of body.items) {
      const objective = await createObjectiveRecord(store, workforce, {
        orgId: auth.orgId,
        name: item.name,
        description: item.description,
      });
      results.push({ id: objective.id, status: "created" as const });
    }
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.post("/api/v1/studio/tasks", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const actor = store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    const body = bulkItems(
      z.object({
        name: z.string().min(1),
        objectiveId: z.string().nullable().optional(),
        assigneePrincipalId: z.string().nullable().optional(),
        priority: taskPriority.optional(),
        description: z.string().optional(),
      }),
    ).parse(await c.req.json());
    const results = [];
    for (const item of body.items) {
      const created = await createTaskRecord(
        store,
        workforce,
        {
          orgId: auth.orgId,
          name: item.name,
          description: item.description,
          objectiveId: item.objectiveId,
          assigneePrincipalId: item.assigneePrincipalId,
          priority: item.priority,
          createdByPrincipalId: actor.id,
        },
        auth,
      );
      await persistCreatedRun(created.runId);
      if (created.runId && env.inlineWorker) {
        void drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
      results.push({ id: created.task.id, status: "created" as const, runId: created.runId });
    }
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.get("/api/v1/objectives", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const items = await workforce.listObjectives(auth.orgId);
    return c.json(ok({ items }));
  });

  app.post("/api/v1/objectives", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().default(""),
        projectUnitId: z.string().nullable().optional(),
      })
      .parse(await c.req.json());
    const objective = await createObjectiveRecord(store, workforce, {
      orgId: auth.orgId,
      name: body.name,
      description: body.description,
      projectUnitId: body.projectUnitId,
    });
    return c.json(ok({ objective }), 201);
  });

  app.get("/api/v1/tasks", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const status = c.req.query("status") as TaskStatus | undefined;
    const items = await workforce.listTasks({
      orgId: auth.orgId,
      objectiveId: c.req.query("objectiveId") ?? undefined,
      assigneePrincipalId: c.req.query("assigneePrincipalId") ?? undefined,
      status: status && taskStatus.safeParse(status).success ? status : undefined,
    });
    return c.json(ok({ items }));
  });

  app.post("/api/v1/tasks", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const actor = store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().default(""),
        objectiveId: z.string().nullable().optional(),
        assigneePrincipalId: z.string().nullable().optional(),
        priority: taskPriority.default("normal"),
        dueAt: z.string().nullable().optional(),
        projectUnitId: z.string().nullable().optional(),
      })
      .parse(await c.req.json());
    const created = await createTaskRecord(
      store,
      workforce,
      {
        orgId: auth.orgId,
        name: body.name,
        description: body.description,
        objectiveId: body.objectiveId,
        assigneePrincipalId: body.assigneePrincipalId,
        priority: body.priority as TaskPriority,
        createdByPrincipalId: actor.id,
        dueAt: body.dueAt,
        projectUnitId: body.projectUnitId,
      },
      auth,
    );
    await persistCreatedRun(created.runId);
    if (created.runId && env.inlineWorker) {
      void drainWorker(store, workerKeys, "inline", env.leaseMs);
    }
    return c.json(ok({ task: created.task, runId: created.runId, created: created.created }), 201);
  });

  app.patch("/api/v1/tasks/:id", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const actor = store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    const task = await workforce.getTask(c.req.param("id"));
    if (!task || task.orgId !== auth.orgId) {
      throw notFound("Task");
    }
    const body = z
      .object({
        assigneePrincipalId: z.string().nullable().optional(),
        priority: taskPriority.optional(),
        status: z.enum(["blocked", "cancelled", "completed"]).optional(),
        resultSummary: z.string().optional(),
      })
      .parse(await c.req.json());
    if (body.assigneePrincipalId !== undefined) {
      const assigned = await assignTask(
        store,
        workforce,
        task.id,
        body.assigneePrincipalId,
        actor.id,
        auth,
      );
      await persistCreatedRun(assigned.runId);
      if (assigned.runId && assigned.created && env.inlineWorker) {
        void drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
      return c.json(ok({ task: assigned.task, runId: assigned.runId, created: assigned.created }));
    }
    const patch: Partial<typeof task> = {};
    if (body.priority) {
      patch.priority = body.priority;
    }
    if (body.status) {
      patch.status = body.status;
    }
    if (body.resultSummary) {
      patch.resultSummary = body.resultSummary;
    }
    const updated = await workforce.updateTask(task.id, patch);
    if (body.priority && body.priority !== task.priority) {
      await recordTaskEvent(workforce, {
        taskId: task.id,
        type: "priority_changed",
        actorPrincipalId: actor.id,
        metadata: { from: task.priority, to: body.priority },
      });
    }
    if (body.status && body.status !== task.status) {
      await recordTaskEvent(workforce, {
        taskId: task.id,
        type:
          body.status === "completed"
            ? "completed"
            : body.status === "cancelled"
              ? "cancelled"
              : "blocked",
        actorPrincipalId: actor.id,
        fromStatus: task.status,
        toStatus: body.status,
        metadata: body.resultSummary ? { resultSummary: body.resultSummary } : {},
      });
    }
    return c.json(ok({ task: updated }));
  });

  app.post("/api/v1/tasks/:id/start", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const actor = store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    try {
      const started = await startTask(store, workforce, c.req.param("id"), actor.id, auth);
      await persistCreatedRun(started.runId);
      if (started.created && env.inlineWorker) {
        void drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
      return c.json(ok({ runId: started.runId, threadId: started.threadId, created: started.created }));
    } catch {
      throw notFound("Task");
    }
  });

  app.post("/api/v1/tasks/:id/retry", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const actor = store.ensureHumanPrincipal(auth.orgId, auth.userId, "Me");
    try {
      const retried = await retryTask(store, workforce, c.req.param("id"), actor.id, auth);
      await persistCreatedRun(retried.runId);
      if (retried.created && env.inlineWorker) {
        void drainWorker(store, workerKeys, "inline", env.leaseMs);
      }
      return c.json(ok({ runId: retried.runId, threadId: retried.threadId, created: retried.created }));
    } catch {
      throw notFound("Task");
    }
  });

  app.get("/api/v1/inbox", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const items = await inboxForOrg(store, workforce, auth.orgId, c.req.query("agentId") ?? undefined);
    return c.json(ok({ items }));
  });

  app.get("/api/v1/tasks/:id/events", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const task = await workforce.getTask(c.req.param("id"));
    if (!task || task.orgId !== auth.orgId) {
      throw notFound("Task");
    }
    return c.json(ok({ items: await workforce.listEvents(task.id) }));
  });

  app.post("/api/v1/studio/access", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(
      z.object({
        principalId: z.string().min(1),
        toolId: z.string().min(1),
        kind: z.enum(["can_use", "can_read"]).default("can_use"),
      }),
    ).parse(await c.req.json());
    const results = body.items.map((item) => {
      if (!store.principals.get(item.principalId)) {
        return { toolId: item.toolId, status: "not_found" as const };
      }
      const grant = store.upsertAccessGrant({
        orgId: auth.orgId,
        principalId: item.principalId,
        toolId: item.toolId,
        kind: item.kind,
      });
      store.bumpGraphRevision(auth.orgId);
      return { id: grant.id, status: "created" as const };
    });
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }), 201);
  });

  app.post("/api/v1/studio/relationships", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = bulkItems(relationshipItem).parse(await c.req.json());
    const results = body.items.map((item) => writeRelationship(store, auth.orgId, item));
    for (const item of body.items) {
      if (item.kind === "has_skill") {
        compileAgentsTouchedBySkillEdge(store, auth.orgId, item.fromId);
      }
    }
    await persistGraphWrite(store, auth.orgId);
    return c.json(ok({ results, graph: buildGraphView(store, auth.orgId) }));
  });

  app.post("/api/v1/studio/relationships/replace", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = relationshipItem.parse(await c.req.json());
    if (body.kind !== "reports_to") {
      throw validationError("Only reports_to can be replaced");
    }
    const result = replaceReportsTo(store, auth.orgId, body.fromId, body.toId);
    await persistGraphWrite(store, auth.orgId);
    return c.json(ok({ result, graph: buildGraphView(store, auth.orgId) }));
  });

  app.delete("/api/v1/studio/relationships/:edgeId", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const edgeId = c.req.param("edgeId");
    const agentSkill = store.agentSkills.get(edgeId);
    const roleSkill = store.roleSkills.get(edgeId);
    if (!deleteRelationship(store, auth.orgId, edgeId)) {
      throw notFound("Relationship");
    }
    if (agentSkill) {
      compileAgentFromGraph(store, auth.orgId, agentSkill.agentId);
    } else if (roleSkill) {
      compileAgentsTouchedBySkillEdge(store, auth.orgId, roleSkill.roleId);
    }
    await persistGraphWrite(store, auth.orgId);
    return c.json(ok({ graph: buildGraphView(store, auth.orgId) }));
  });

  app.post("/api/v1/studio/projects/:unitId/end", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const unit = store.units.get(c.req.param("unitId"));
    if (!unit || unit.orgId !== auth.orgId) {
      throw notFound("Project");
    }
    endProject(store, auth.orgId, unit.id);
    return c.json(ok({ graph: buildGraphView(store, auth.orgId) }));
  });

  app.post("/api/v1/studio/workflows", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().default(""),
        definition: z.record(z.unknown()).default({}),
      })
      .parse(await c.req.json());
    const workflow = {
      id: id("wfl"),
      orgId: auth.orgId,
      name: body.name,
      description: body.description,
      definition: body.definition,
      status: "draft" as const,
    };
    store.workflows.set(workflow.id, workflow);
    return c.json(ok({ workflow }), 201);
  });

  app.post("/api/v1/studio/autonomy", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z
      .object({
        principalId: z.string().min(1),
        level: z.number().int().min(1).max(5),
      })
      .parse(await c.req.json());
    if (!store.principals.get(body.principalId)) {
      throw notFound("Principal");
    }
    applyAutonomyPreset(store, auth.orgId, body.principalId, body.level);
    return c.json(ok({ applied: true, level: body.level }));
  });

  const connectorItem = z.object({
    kind: z.enum(["mcp", "openapi", "webhook"]),
    name: z.string().min(1),
    purpose: z
      .enum(["shop", "outbound", "commerce", "email", "messaging", "calendar", "custom"])
      .optional(),
    origin: z.string().url(),
    credential: z.object({
      label: z.string().min(1),
      kind: z.enum(["bearer", "header_map", "basic", "mcp", "webhook_secret"]),
      secret: z.string().min(1),
    }),
    operations: z
      .array(
        z.object({
          toolId: z.string().min(1),
          side: z.enum(["cloud", "client", "native"]).optional(),
          risk: z.enum(["low", "sensitive_read", "external_write", "destructive", "privileged"]),
          inputSchema: z.record(z.unknown()).optional(),
          outputSchema: z.record(z.unknown()).optional(),
          binding: z.object({
            method: z.string().optional(),
            path: z.string().optional(),
            mcpName: z.string().optional(),
          }),
        }),
      )
      .max(500)
      .default([]),
  });

  app.post("/api/v1/studio/connectors", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z.object({ items: z.array(connectorItem).min(1).max(500) }).parse(await c.req.json());
    const results = [];
    for (const item of body.items) {
      const attached = attachConnector(
        store,
        { vaultKey: env.vaultKey, vaultKeyPrevious: env.vaultKeyPrevious },
        {
          orgId: auth.orgId,
          createdBy: auth.userId,
          kind: item.kind,
          name: item.name,
          purpose: item.purpose,
          origin: item.origin,
          credential: item.credential,
          operations: item.operations,
        },
      );
      results.push({
        connectorId: attached.connector.id,
        status: "ok" as const,
        toolIds: attached.capabilities.map((row) => row.toolId),
        revision: attached.connector.revision,
      });
    }
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ results }), 201);
  });

  app.post("/api/v1/studio/custom-tools", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const body = z
      .object({
        items: z
          .array(
            z.object({
              toolId: z.string().min(1),
              definition: z.object({
                steps: z
                  .array(
                    z.object({
                      toolId: z.string().min(1),
                      version: z.number().int().positive(),
                      map: z.record(z.string()).optional(),
                      filter: z.record(z.unknown()).optional(),
                    }),
                  )
                  .min(1)
                  .max(3),
                groupBy: z.array(z.string()).optional(),
                cap: z.number().int().positive().optional(),
                cutoffDays: z.number().int().positive().optional(),
              }),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(await c.req.json());
    const results = body.items.map((item) => {
      const saved = saveCustomTool(store, { orgId: auth.orgId, toolId: item.toolId, definition: item.definition });
      return { toolId: saved.toolId, status: "ok" as const, risk: saved.risk };
    });
    await persistOrgSnapshot(store, auth.orgId);
    return c.json(ok({ results }), 201);
  });

  app.post("/api/v1/hooks/:connectorId", async (c) => {
    if (!env.vaultKey?.length) {
      throw new AppError("INTERNAL_ERROR", "Server misconfiguration", 500);
    }
    const connector = store.connectors.get(c.req.param("connectorId"));
    if (!connector || connector.kind !== "webhook") {
      throw notFound("Connector");
    }
    const rawBody = await c.req.text();
    const timestamp = c.req.header("x-webhook-timestamp") ?? "";
    const nonce = c.req.header("x-webhook-nonce") ?? "";
    const signature = c.req.header("x-webhook-signature") ?? "";
    const credential = connector.credentialId ? store.credentials.get(connector.credentialId) : undefined;
    if (!credential) {
      throw new AppError("INTERNAL_ERROR", "Server misconfiguration", 500);
    }
    const secret = openSecret({
      sealed: credential.sealed,
      masterKey: env.vaultKey,
      previousKey: env.vaultKeyPrevious,
      orgId: credential.orgId,
      recordId: credential.id,
      kind: credential.kind,
      keyVersion: credential.keyVersion,
    });
    const verdict = verifyWebhook({ secret, timestamp, nonce, rawBody, signature });
    if (verdict === "stale") {
      throw validationError("stale webhook timestamp");
    }
    if (verdict === "unauthorized") {
      throw unauthorized();
    }
    const delivery = {
      id: id("whd"),
      connectorId: connector.id,
      nonce,
      timestamp,
      bodySealed: sealSecret({
        plaintext: rawBody,
        masterKey: env.vaultKey,
        orgId: connector.orgId,
        recordId: connector.id,
        kind: "webhook_body",
      }),
      createdAt: new Date().toISOString(),
    };
    if (!store.rememberWebhookDelivery(delivery)) {
      throw conflict("webhook nonce replayed");
    }
    await store.persist("webhook_deliveries", delivery);
    const assignee =
      [...store.principals.values()].find(
        (row) => row.orgId === connector.orgId && row.type === "human" && /sales manager/i.test(row.displayName),
      ) ?? store.ensureHumanPrincipal(connector.orgId, "webhook", "Webhook");
    await createTaskRecord(
      store,
      workforce,
      {
        orgId: connector.orgId,
        name: `Webhook ${connector.name}`,
        description: "Inbound webhook",
        assigneePrincipalId: assignee.id,
        createdByPrincipalId: assignee.id,
      },
      {
        orgId: connector.orgId,
        userId: assignee.userId ?? "webhook",
        deviceId: "webhook",
        sessionId: "webhook",
      },
    );
    return c.json(ok({ received: true }));
  });

  app.post("/api/v1/studio/agents/:agentId/compile", async (c) => {
    const auth = await requireAuth(runtime, env, c.req.header("Authorization"));
    const agent = store.agents.get(c.req.param("agentId"));
    if (!agent || agent.orgId !== auth.orgId) {
      throw notFound("Agent");
    }
    const version = compileAgentFromGraph(store, auth.orgId, agent.id);
    return c.json(ok({ version }));
  });

  return app;
}

export type MemoryListScope = MemoryScope;
