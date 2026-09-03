import { recordActionOutcome } from "./action-outcomes.ts";
import { compileCapabilitiesOffline } from "./capability-compiler.ts";
import { isCapabilityGap, resolveCapabilities } from "./capability-resolver.ts";
import {
  connectorHealthLookup,
  healthStateForError,
  recordConnectorHealth,
} from "./connector-health.ts";
import { versionRefsForTool } from "./connector-versions.ts";
import {
  executeCapability,
  redactConnectorResult,
  type ConnectorFetch,
  type LookupFn,
} from "./connectors.ts";
import { buildContext, recordCompilation } from "./context-compiler.ts";
import { argsHash, embedText, openSecret, sealSecret } from "./crypto.ts";
import { executeCustomTool } from "./custom-tools.ts";
import type { JarvisEnv } from "./env.ts";
import { issueEnvelope } from "./envelope.ts";
import { id } from "./ids.ts";
import { completeModel } from "./model.ts";
import { persistConnectSession, persistThreadWrite } from "./persist.ts";
import { planPrompt, planRegistryFallback } from "./planner.ts";
import { principalForAgent } from "./org-graph.ts";
import { evaluatePolicy } from "./policy.ts";
import { isFirstPartyTool, resolveToolDef } from "./registry.ts";
import type { RuntimeRepo } from "./runtime-repo.ts";
import {
  completedConnectForRun,
  integrationStatus,
  isConnectRequired,
  pendingConnectForRun,
  startConnect,
} from "./integrations.ts";
import { grantedToolsForAgent } from "./studio-access.ts";
import type { JarvisStore } from "./store.ts";
import { isOpenServiceId } from "./tools.ts";
import { searchWeb } from "./web-search.ts";
import type { AgentVersion, MemoryScope, Principal, Run, ToolInvocation } from "./types.ts";
import {
  completeCurrentTask,
  createTaskRecord,
  markTaskBlocked,
  markTaskStarted,
  updateCurrentTask,
  type WorkforceRepo,
} from "./workforce.ts";

export type RuntimeKeys = Pick<
  JarvisEnv,
  "serverPrivateKeyB64" | "modelApiKey" | "modelBaseUrl" | "modelName" | "vaultKey" | "vaultKeyPrevious"
> & {
  workforce?: WorkforceRepo;
  runtime?: RuntimeRepo;
  fetch?: ConnectorFetch;
  lookup?: LookupFn;
};

async function persistRun(store: JarvisStore, keys: RuntimeKeys, runId: string): Promise<void> {
  const run = store.getRun(runId);
  if (run && keys.runtime) {
    await keys.runtime.upsertRun(run);
  }
}

async function failRun(store: JarvisStore, run: Run, keys: RuntimeKeys): Promise<void> {
  store.setRunStatus(run.id, "failed", { clearLease: true });
  await persistRun(store, keys, run.id);
  if (run.taskId && keys.workforce) {
    await markTaskBlocked(keys.workforce, run.taskId, run.id);
  }
}

const DURABLE_EVENTS = new Set([
  "message_complete",
  "tool_started",
  "tool_finished",
  "approval_required",
  "connect_required",
  "resolve_integrations",
  "run_state",
  "error",
  "memory_update",
]);

export async function emitDurable(
  store: JarvisStore,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
  keys?: RuntimeKeys,
) {
  if (!DURABLE_EVENTS.has(eventType)) {
    return null;
  }
  const event = store.appendEvent(runId, eventType, payload);
  if (event && keys?.runtime) {
    await keys.runtime.upsertEvent(event);
  }
  return event;
}

function activeVersion(store: JarvisStore, run: Run): AgentVersion {
  const switches = store
    .stepsFor(run.id)
    .filter((step) => step.type === "config_switch");
  const last = switches.at(-1);
  if (last && typeof last.payload.toVersionId === "string") {
    const version = store.getVersion(last.payload.toVersionId);
    if (version) {
      return version;
    }
  }
  return store.getVersion(run.agentVersion)!;
}

export function memoryContentFromArgs(args: Record<string, unknown>): string {
  const raw = args.content ?? args.text ?? args.fact ?? args.memory ?? "";
  return String(raw).trim();
}

async function rememberCloud(
  store: JarvisStore,
  run: Run,
  args: Record<string, unknown>,
  keys?: RuntimeKeys,
) {
  const content = memoryContentFromArgs(args);
  if (!content) {
    return { stored: false, reason: "empty_content" };
  }
  const scopeType = (args.scopeType as MemoryScope) ?? "personal";
  const memory = store.addMemory({
    id: id("mem"),
    orgId: run.orgId,
    scopeType,
    scopeId: scopeType === "conversation" ? run.threadId : scopeType === "agent" ? run.agentId : null,
    subjectUserId: scopeType === "personal" ? run.actorId : null,
    createdByAgentId: run.agentId,
    source: args.source === "inferred" ? "inferred" : "explicit",
    content,
    importance: 0.6,
    confidence: 1,
    sensitivity: "normal",
    embedding: embedText(content),
    createdAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString(),
    expiresAt: null,
  });
  await emitDurable(store, run.id, "memory_update", { memoryId: memory.id, scopeType }, keys);
  await store.persist("memories", memory);
  return { memoryId: memory.id, stored: true };
}

function recallCloud(store: JarvisStore, run: Run, version: AgentVersion, args: Record<string, unknown>) {
  const query = String(args.query ?? "");
  const hits = store.recall({
    orgId: run.orgId,
    actorId: run.actorId,
    agentId: run.agentId,
    threadId: run.threadId,
    allowScopes: version.memoryPolicy.allowScopes,
    query,
    embedding: embedText(query),
  });
  return {
    memories: hits.map((hit) => ({
      id: hit.id,
      content: hit.content,
      scopeType: hit.scopeType,
      source: hit.source,
    })),
  };
}

function salesManagerPrincipal(store: JarvisStore, orgId: string): Principal | undefined {
  return [...store.principals.values()].find(
    (row) => row.orgId === orgId && row.type === "human" && /sales manager/i.test(row.displayName),
  );
}

function taskItemsFromArgs(
  store: JarvisStore,
  run: Run,
  args: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (Array.isArray(args.items)) {
    return args.items.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (Array.isArray(args.segments)) {
    return args.segments.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  const last = [...store.invocations.values()]
    .filter((row) => row.runId === run.id && row.status === "succeeded" && row.tool !== "task.create")
    .at(-1);
  const result = last?.result;
  if (result && typeof result === "object") {
    const row = result as Record<string, unknown>;
    if (Array.isArray(row.segments)) {
      return row.segments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
    if (Array.isArray(row.items)) {
      return row.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
  }
  return [];
}

async function createInboxTasks(
  store: JarvisStore,
  run: Run,
  args: Record<string, unknown>,
  workforce: WorkforceRepo,
): Promise<unknown> {
  const items = taskItemsFromArgs(store, run, args);
  const assignee =
    salesManagerPrincipal(store, run.orgId) ??
    store.ensureHumanPrincipal(run.orgId, run.actorId, "Me");
  const actor = principalForAgent(store, run.orgId, run.agentId);
  const created: string[] = [];
  const rows = items.length > 0 ? items.slice(0, 50) : [{ name: "Follow up segmented customers", count: 0 }];
  for (const item of rows) {
    const name =
      String(item.name ?? item.title ?? "").trim() ||
      `Follow up ${String(item.country ?? "")} ${String(item.language ?? "")}`.trim();
    const result = await createTaskRecord(
      store,
      workforce,
      {
        orgId: run.orgId,
        name,
        description: String(
          item.description ??
            `country=${String(item.country ?? "")} language=${String(item.language ?? "")} count=${String(item.count ?? "")}`,
        ),
        assigneePrincipalId: assignee.id,
        createdByPrincipalId: actor?.id ?? null,
        priority: "normal",
      },
      {
        orgId: run.orgId,
        userId: run.actorId,
        deviceId: run.deviceId,
        sessionId: run.sessionId,
      },
    );
    created.push(result.task.id);
  }
  return { count: created.length, taskIds: created };
}

export async function executeCloudTool(
  store: JarvisStore,
  run: Run,
  version: AgentVersion,
  tool: string,
  args: Record<string, unknown>,
  workforce?: WorkforceRepo,
  keys?: RuntimeKeys,
): Promise<unknown> {
  if (tool === "memory.remember") {
    return rememberCloud(store, run, args, keys);
  }
  if (tool === "memory.recall") {
    return recallCloud(store, run, version, args);
  }
  if (tool === "integrations.status") {
    return integrationStatus(store, run.orgId, {
      product: typeof args.product === "string" ? args.product : undefined,
      purpose: typeof args.purpose === "string" ? args.purpose : undefined,
    });
  }
  if (tool === "integrations.connect") {
    const started = startConnect(store, {
      orgId: run.orgId,
      agentId: run.agentId,
      createdBy: run.actorId,
      runId: run.id,
      product: typeof args.product === "string" ? args.product : undefined,
      purpose: typeof args.purpose === "string" ? args.purpose : undefined,
      env: process.env,
    });
    if ("connectId" in started) {
      await persistConnectSession(store, started.connectId);
    }
    return started;
  }
  if (tool === "web.search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { items: [], error: "empty_query" };
    }
    return searchWeb(query, {
      apiKey: keys?.modelApiKey,
      baseUrl: keys?.modelBaseUrl,
      model: keys?.modelName,
    });
  }
  if (tool === "task.create") {
    if (!workforce) {
      return { error: "no_workforce" };
    }
    return createInboxTasks(store, run, args, workforce);
  }
  const granted = grantedToolsForAgent(store, run.orgId, run.agentId);
  if (store.customToolById(run.orgId, tool) || store.enabledCapability(run.orgId, tool)) {
    if (!keys?.vaultKey?.length) {
      return { error: "vault_unavailable" };
    }
    const vault = { vaultKey: keys.vaultKey, vaultKeyPrevious: keys.vaultKeyPrevious };
    const deps = { fetch: keys.fetch, lookup: keys.lookup };
    if (store.customToolById(run.orgId, tool)) {
      const executed = await executeCustomTool(
        store,
        run.orgId,
        tool,
        args,
        async (stepId, stepArgs) => executeCapability(store, vault, run.orgId, stepId, stepArgs, deps),
        granted,
      );
      if ("error" in executed) {
        return { error: executed.error };
      }
      return executed.result;
    }
    const capability = store.enabledCapability(run.orgId, tool)!;
    if (capability.risk === "external_write" && keys.runtime) {
      const idempotencyKey = String(args.idempotencyKey ?? args["x-idempotency-key"] ?? "");
      const key = idempotencyKey || `${run.id}:${tool}`;
      const scope = `connector.${capability.connectorId}.${tool}`;
      const cached = await keys.runtime.getIdempotency(key, scope);
      if (cached) {
        return cached;
      }
      const result = await executeCapability(store, vault, run.orgId, tool, args, deps);
      recordExecutionHealth(store, run.orgId, capability.connectorId, result);
      await keys.runtime.storeIdempotency(key, scope, result, 86_400_000);
      return result;
    }
    const result = await executeCapability(store, vault, run.orgId, tool, args, deps);
    recordExecutionHealth(store, run.orgId, capability.connectorId, result);
    return result;
  }
  if (tool === "task.update_current" || tool === "task.complete_current") {
    if (!run.taskId || !workforce) {
      return { error: "no_current_task" };
    }
    if (tool === "task.complete_current") {
      const resultSummary = String(args.result_summary ?? args.resultSummary ?? "").trim();
      if (!resultSummary) {
        return { error: "result_summary_required" };
      }
      const task = await completeCurrentTask(workforce, run.taskId, resultSummary, run.id);
      return { taskId: task.id, status: task.status, resultSummary: task.resultSummary };
    }
    const status = args.status === "blocked" ? "blocked" : "in_progress";
    const note = typeof args.note === "string" ? args.note : undefined;
    const task = await updateCurrentTask(workforce, run.taskId, status, note, run.id);
    return { taskId: task.id, status: task.status };
  }
  throw new Error(`cloud tool not executable: ${tool}`);
}

function maybeConfigSwitch(
  store: JarvisStore,
  run: Run,
  mention: string | undefined,
): AgentVersion {
  const current = activeVersion(store, run);
  if (!mention) {
    return current;
  }
  const target = store.resolveAgent(run.orgId, mention);
  if (target && target.id !== run.agentId) {
    run.agentId = target.id;
  }
  if (!target) {
    return current;
  }
  const next = store.latestVersion(target.id);
  if (!next || next.id === current.id) {
    return current;
  }
  store.addStep(run.id, "config_switch", {
    fromVersionId: current.id,
    toVersionId: next.id,
    fromAgentId: current.agentId,
    toAgentId: next.agentId,
  });
  return next;
}

async function persistLatestStep(
  store: JarvisStore,
  keys: RuntimeKeys,
  runId: string,
  type: string,
): Promise<void> {
  const step = store.stepsFor(runId).filter((row) => row.type === type).at(-1);
  if (step && keys.runtime) {
    await keys.runtime.upsertStep(step);
  }
}

export async function applyPlannedAction(
  store: JarvisStore,
  run: Run,
  keys: RuntimeKeys,
  action: { tool: string; arguments: Record<string, unknown>; mention?: string },
): Promise<"continue" | "park" | "done"> {
  const version = maybeConfigSwitch(store, run, action.mention);
  await persistLatestStep(store, keys, run.id, "config_switch");
  await persistRun(store, keys, run.id);
  const def = resolveToolDef(store, run.orgId, action.tool);
  if (!def) {
    await emitDurable(store, run.id, "error", { message: `unknown tool ${action.tool}` }, keys);
    await failRun(store, run, keys);
    return "done";
  }
  if (action.tool === "desktop.open_service") {
    const serviceId = String(action.arguments.serviceId ?? "");
    if (!isOpenServiceId(serviceId)) {
      store.audit({
        orgId: run.orgId,
        actorId: run.actorId,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        action: "desktop.open_service",
        policyOutcome: "DENY",
        approvalId: null,
        deviceId: run.deviceId,
        executionResult: "denied",
      });
      await emitDurable(store, run.id, "error", { message: "unknown serviceId" }, keys);
      await failRun(store, run, keys);
      return "done";
    }
  }

  const grantId =
    typeof action.arguments.grantId === "string" ? action.arguments.grantId : null;
  const principal = principalForAgent(store, run.orgId, run.agentId);
  const outcome = evaluatePolicy({
    store,
    orgId: run.orgId,
    deviceId: run.deviceId,
    agentToolIds: version.requestedToolIds ?? version.toolIds,
    grantedToolIds: grantedToolsForAgent(store, run.orgId, run.agentId),
    principalId: principal?.id,
    tool: action.tool,
    grantId,
  });

  const sealedTool = !isFirstPartyTool(action.tool);
  const versionRefs = versionRefsForTool(store, run.orgId, action.tool);
  const invocationId = id("ti");
  const step = store.addStep(run.id, "tool_invocation", {
    tool: action.tool,
    arguments: sealedTool ? {} : action.arguments,
  });
  const invocation: ToolInvocation = {
    id: invocationId,
    runId: run.id,
    runStepId: step.id,
    sessionId: run.sessionId,
    deviceId: run.deviceId,
    requestId: id("req"),
    side: def.side,
    tool: action.tool,
    arguments: sealedTool ? {} : action.arguments,
    argsHash: argsHash(action.arguments),
    status: "pending",
    result: null,
    argumentsSealed: sealedTool
      ? sealSecret({
          plaintext: JSON.stringify(action.arguments),
          masterKey: keys.vaultKey,
          orgId: run.orgId,
          recordId: invocationId,
          kind: "invocation_args",
        })
      : null,
    resultSealed: null,
    grantId,
    connectorVersionId: versionRefs.connectorVersionId,
    capabilityVersionId: versionRefs.capabilityVersionId,
    nonce: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };
  store.createInvocation(invocation);
  if (keys.runtime) {
    await keys.runtime.upsertStep(step);
    await keys.runtime.upsertInvocation(invocation);
  }

  store.audit({
    orgId: run.orgId,
    actorId: run.actorId,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
    action: action.tool,
    policyOutcome: outcome,
    approvalId: null,
    deviceId: run.deviceId,
    executionResult: outcome === "DENY" ? "denied" : "pending",
  });

  if (outcome === "DENY") {
    store.completeInvocation(invocation.id, "failed", { error: "denied" });
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
    }
    await emitDurable(store, run.id, "error", { message: "policy denied", tool: action.tool }, keys);
    await failRun(store, run, keys);
    return "done";
  }

  if (outcome === "ALLOW_WITH_APPROVAL") {
    const approval = store.createApproval({
      id: id("apr"),
      toolInvocationId: invocation.id,
      tool: invocation.tool,
      argsHash: invocation.argsHash,
      agentVersion: version.id,
      runId: run.id,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      decidedAt: null,
      decision: "pending",
    });
    invocation.status = "sent";
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(invocation);
      await keys.runtime.upsertApproval(approval);
    }
    await emitDurable(store, run.id, "approval_required", {
      approvalId: approval.id,
      toolInvocationId: invocation.id,
      tool: invocation.tool,
      arguments: isFirstPartyTool(invocation.tool) ? invocation.arguments : {},
    }, keys);
    await emitDurable(store, run.id, "run_state", { status: "waiting_for_approval" }, keys);
    store.setRunStatus(run.id, "waiting_for_approval", { clearLease: true });
    await persistRun(store, keys, run.id);
    return "park";
  }

  return await dispatchAllowed(store, run, version, keys, invocation, action.arguments);
}

function invocationArgs(
  invocation: ToolInvocation,
  keys: RuntimeKeys,
  orgId: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (isFirstPartyTool(invocation.tool) || !invocation.argumentsSealed) {
    return Object.keys(invocation.arguments).length > 0 ? invocation.arguments : fallback;
  }
  try {
    return JSON.parse(
      openSecret({
        sealed: invocation.argumentsSealed,
        masterKey: keys.vaultKey,
        previousKey: keys.vaultKeyPrevious,
        orgId,
        recordId: invocation.id,
        kind: "invocation_args",
        keyVersion: 1,
      }),
    ) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

async function dispatchAllowed(
  store: JarvisStore,
  run: Run,
  version: AgentVersion,
  keys: RuntimeKeys,
  invocation: ToolInvocation,
  rawArgs?: Record<string, unknown>,
): Promise<"continue" | "park" | "done"> {
  const def = resolveToolDef(store, run.orgId, invocation.tool)!;
  const args = rawArgs ?? invocationArgs(invocation, keys, run.orgId, invocation.arguments);
  if (def.side === "cloud") {
    invocation.status = "sent";
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(invocation);
    }
    const started = Date.now();
    const result = await executeCloudTool(
      store,
      run,
      version,
      invocation.tool,
      args,
      keys.workforce,
      keys,
    );
    const sealedTool = !isFirstPartyTool(invocation.tool);
    const stored = sealedTool ? redactConnectorResult(result) : result;
    if (sealedTool) {
      invocation.resultSealed = sealSecret({
        plaintext: JSON.stringify(result),
        masterKey: keys.vaultKey,
        orgId: run.orgId,
        recordId: invocation.id,
        kind: "invocation_result",
      });
    }
    if (isConnectRequired(result)) {
      invocation.status = "sent";
      invocation.result = stored;
      if (keys.runtime) {
        await keys.runtime.upsertInvocation(invocation);
      }
      await emitDurable(store, run.id, "connect_required", {
        connectId: result.connectId,
        toolInvocationId: invocation.id,
        purpose: result.purpose,
        provider: result.provider,
        ask: result.ask,
        candidates: result.candidates,
        authMethods: result.authMethods,
        fields: result.fields,
      }, keys);
      await emitDurable(store, run.id, "run_state", { status: "waiting_for_connect" }, keys);
      store.setRunStatus(run.id, "waiting_for_connect", { clearLease: true });
      await persistRun(store, keys, run.id);
      return "park";
    }
    const saved = store.completeInvocation(invocation.id, "succeeded", stored);
    if (saved && invocation.resultSealed) {
      saved.resultSealed = invocation.resultSealed;
    }
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
    }
    recordActionOutcome(store, run, store.getInvocation(invocation.id)!);
    await emitDurable(store, run.id, "tool_started", {
      toolInvocationId: invocation.id,
      tool: invocation.tool,
    }, keys);
    await emitDurable(store, run.id, "tool_finished", {
      toolInvocationId: invocation.id,
      result: stored,
    }, keys);
    store.trace({
      runId: run.id,
      runStepId: invocation.runStepId,
      modelTier: version.modelTier,
      latencyMs: Date.now() - started,
      tokenCount: null,
      memoryRetrievalIds:
        invocation.tool === "memory.recall" &&
        result &&
        typeof result === "object" &&
        "memories" in result
          ? (result as { memories: { id: string }[] }).memories.map((row) => row.id)
          : [],
      toolPlanning: { tool: invocation.tool },
      errorDetails: null,
    });
    store.audit({
      orgId: run.orgId,
      actorId: run.actorId,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
      action: invocation.tool,
      policyOutcome: "ALLOW",
      approvalId: null,
      deviceId: run.deviceId,
      executionResult: "succeeded",
    });
    return "continue";
  }

  const envelope = issueEnvelope({
    serverPrivateKeyB64: keys.serverPrivateKeyB64,
    toolInvocationId: invocation.id,
    runId: run.id,
    sessionId: run.sessionId,
    deviceId: run.deviceId,
    tool: invocation.tool,
    arguments: invocation.arguments,
    grantId: invocation.grantId,
  });
  invocation.requestId = envelope.requestId;
  invocation.status = "sent";
  invocation.nonce = envelope.nonce;
  invocation.expiresAt = envelope.expiresAt;
  if (keys.runtime) {
    const first = await keys.runtime.rememberNonce(envelope.nonce);
    if (!first) {
      store.completeInvocation(invocation.id, "failed", { error: "nonce replay" });
      await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
      await failRun(store, run, keys);
      return "done";
    }
    await keys.runtime.upsertInvocation(invocation);
  }
  await emitDurable(store, run.id, "tool_started", {
    toolInvocationId: invocation.id,
    tool: invocation.tool,
    side: def.side,
    envelope,
  }, keys);
  const parked =
    def.side === "native" ? "waiting_for_local_tool" : "waiting_for_local_tool";
  await emitDurable(store, run.id, "run_state", { status: parked }, keys);
  store.setRunStatus(run.id, parked, { clearLease: true });
  await persistRun(store, keys, run.id);
  return "park";
}

export async function resumeAfterApproval(
  store: JarvisStore,
  run: Run,
  keys: RuntimeKeys,
  invocation: ToolInvocation,
): Promise<void> {
  if (argsHash(invocation.arguments) !== invocation.argsHash) {
    store.completeInvocation(invocation.id, "failed", { error: "args mutated" });
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
    }
    await failRun(store, run, keys);
    return;
  }
  if (invocation.grantId) {
    const grant = store.grants.get(invocation.grantId);
    const expired = Boolean(grant?.expiresAt && Date.parse(grant.expiresAt) < Date.now());
    if (!grant || grant.revokedAt || expired) {
      store.completeInvocation(invocation.id, "failed", { error: "grant revoked" });
      if (keys.runtime) {
        await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
      }
      await failRun(store, run, keys);
      return;
    }
  }
  const version = activeVersion(store, run);
  const principal = principalForAgent(store, run.orgId, run.agentId);
  const outcome = evaluatePolicy({
    store,
    orgId: run.orgId,
    deviceId: run.deviceId,
    agentToolIds: version.requestedToolIds ?? version.toolIds,
    grantedToolIds: grantedToolsForAgent(store, run.orgId, run.agentId),
    principalId: principal?.id,
    tool: invocation.tool,
    grantId: invocation.grantId,
  });
  if (outcome === "DENY") {
    store.completeInvocation(invocation.id, "failed", { error: "denied" });
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(store.getInvocation(invocation.id)!);
    }
    await failRun(store, run, keys);
    return;
  }
  await dispatchAllowed(store, run, version, keys, invocation);
}

/**
 * Update connector health from an execution result. A connector-level error
 * (auth expired / unreachable / degraded) is recorded so the resolver can block
 * or reconnect next time; a clean result clears a prior non-READY state.
 */
function recordExecutionHealth(
  store: JarvisStore,
  orgId: string,
  connectorId: string,
  result: unknown,
): void {
  const error = result && typeof result === "object" ? (result as { error?: unknown }).error : undefined;
  if (typeof error === "string") {
    const state = healthStateForError(error);
    if (state) {
      recordConnectorHealth(store, { orgId, connectorId, state, detail: error });
    }
    return;
  }
  const current = store.connectorHealth.get(connectorId);
  if (current && current.state !== "READY") {
    recordConnectorHealth(store, { orgId, connectorId, state: "READY" });
  }
}

async function applyMissingConnect(
  store: JarvisStore,
  run: Run,
  keys: RuntimeKeys,
): Promise<"continue" | "park" | "done"> {
  const granted = grantedToolsForAgent(store, run.orgId, run.agentId);
  const fallback = planRegistryFallback(store, run.orgId, run.agentId, granted, run.prompt);
  if (fallback.kind !== "actions") {
    return "continue";
  }
  const connects = fallback.actions.filter((action) => action.tool === "integrations.connect");
  if (connects.length === 0) {
    return "continue";
  }
  // Capability-first signal: surface every unmet capability once, so the UI can
  // offer a single "Resolve integrations" path instead of per-product prompts.
  const required = compileCapabilitiesOffline(run.prompt);
  const gaps = resolveCapabilities(
    store,
    run.orgId,
    run.agentId,
    required,
    connectorHealthLookup(store),
  ).filter((row) => isCapabilityGap(row.status));
  if (gaps.length > 0) {
    await emitDurable(
      store,
      run.id,
      "resolve_integrations",
      {
        capabilities: gaps.map((row) => ({
          id: row.capability.id,
          purpose: row.capability.purpose,
          status: row.status,
          connectorId: row.connectorId ?? null,
        })),
      },
      keys,
    );
  }
  if (store.stepsFor(run.id).every((step) => step.type !== "user_request")) {
    store.addStep(run.id, "user_request", { prompt: run.prompt });
    await persistLatestStep(store, keys, run.id, "user_request");
  }
  for (const action of connects) {
    const next = await applyPlannedAction(store, run, keys, action);
    if (next === "park" || next === "done") {
      return next;
    }
  }
  return "continue";
}

export async function processRun(store: JarvisStore, run: Run, keys: RuntimeKeys): Promise<void> {
  if (run.workerId && keys.runtime) {
    await keys.runtime.renewLease(run.id, run.workerId, 30_000);
  }
  if (run.taskId && keys.workforce) {
    await markTaskStarted(keys.workforce, run.taskId, run.id);
  }
  const started = Date.now();
  const existing = [...store.invocations.values()].filter((row) => row.runId === run.id);
  const waiting = existing.at(-1);
  if (waiting?.status === "sent" && waiting.tool === "integrations.connect") {
    const completed = completedConnectForRun(store, run.id);
    if (!completed || pendingConnectForRun(store, run.id)) {
      store.setRunStatus(run.id, "waiting_for_connect", { clearLease: true });
      await persistRun(store, keys, run.id);
      return;
    }
    store.completeInvocation(waiting.id, "succeeded", {
      status: "connected",
      provider: completed.providerId,
      toolIds: completed.toolIds,
    });
    if (keys.runtime) {
      await keys.runtime.upsertInvocation(store.getInvocation(waiting.id)!);
    }
    if (keys.modelApiKey) {
      await runModelTurn(store, run, keys);
      return;
    }
  } else if (waiting) {
    if (waiting.status === "succeeded" || waiting.status === "failed") {
      if (keys.modelApiKey && existing.length < 3) {
        await runModelTurn(store, run, keys);
        return;
      }
      await finishRun(store, run, keys, waiting);
      return;
    }
    const approval = store.approvalFor(waiting.id);
    if (approval) {
      if (approval.decision === "approved") {
        if (Date.parse(approval.expiresAt) < Date.now()) {
          store.completeInvocation(waiting.id, "failed", { error: "approval expired" });
          if (keys.runtime) {
            await keys.runtime.upsertInvocation(store.getInvocation(waiting.id)!);
          }
          await failRun(store, run, keys);
          return;
        }
        await resumeAfterApproval(store, run, keys, waiting);
        return;
      }
      if (approval.decision === "rejected") {
        store.completeInvocation(waiting.id, "failed", { error: "rejected" });
        if (keys.runtime) {
          await keys.runtime.upsertInvocation(store.getInvocation(waiting.id)!);
        }
        await failRun(store, run, keys);
        return;
      }
      if (Date.parse(approval.expiresAt) < Date.now()) {
        store.completeInvocation(waiting.id, "failed", { error: "approval expired" });
        if (keys.runtime) {
          await keys.runtime.upsertInvocation(store.getInvocation(waiting.id)!);
        }
        await failRun(store, run, keys);
        return;
      }
      store.setRunStatus(run.id, "waiting_for_approval", { clearLease: true });
      await persistRun(store, keys, run.id);
      return;
    }
    if (waiting.status === "sent") {
      store.setRunStatus(run.id, "waiting_for_local_tool", { clearLease: true });
      await persistRun(store, keys, run.id);
      return;
    }
  }

  const connectNext = await applyMissingConnect(store, run, keys);
  if (connectNext === "park" || connectNext === "done") {
    return;
  }

  if (keys.modelApiKey) {
    await runModelTurn(store, run, keys);
    return;
  }

  const granted = grantedToolsForAgent(store, run.orgId, run.agentId);
  const fallback = planRegistryFallback(store, run.orgId, run.agentId, granted, run.prompt);
  if (fallback.kind === "gap") {
    await finishRun(store, run, keys, undefined, fallback.message);
    return;
  }
  const actions = fallback.kind === "actions" ? fallback.actions : planPrompt(run.prompt);
  store.trace({
    runId: run.id,
    runStepId: null,
    modelTier: activeVersion(store, run).modelTier,
    latencyMs: Date.now() - started,
    tokenCount: run.prompt.split(/\s+/).length,
    memoryRetrievalIds: [],
    toolPlanning: actions,
    errorDetails: null,
  });
  store.addStep(run.id, "user_request", { prompt: run.prompt });
  await persistLatestStep(store, keys, run.id, "user_request");

  for (const action of actions) {
    const next = await applyPlannedAction(store, run, keys, action);
    if (next === "park") {
      return;
    }
    if (next === "done") {
      return;
    }
  }
  const last = [...store.invocations.values()]
    .filter((row) => row.runId === run.id)
    .at(-1);
  await finishRun(store, run, keys, last);
}

async function runModelTurn(store: JarvisStore, run: Run, keys: RuntimeKeys): Promise<void> {
  const version = activeVersion(store, run);
  const task = run.taskId && keys.workforce ? await keys.workforce.getTask(run.taskId) : null;
  const ctx = buildContext({
    store,
    version,
    userId: run.actorId,
    prompt: run.prompt,
    run,
    task,
  });
  const compilation = recordCompilation(store, ctx, run, version);
  if (keys.workforce) {
    await keys.workforce.saveCompilation(compilation);
  }
  const reply = await completeModel(keys, {
    system: ctx.prompt,
    user: run.prompt,
    presentedTools: ctx.presentedTools,
  });
  if (!reply) {
    await finishRun(store, run, keys, undefined, "Done.");
    return;
  }
  if (reply.tool) {
    const next = await applyPlannedAction(store, run, keys, {
      tool: reply.tool,
      arguments: reply.arguments ?? {},
    });
    if (next === "continue") {
      const last = [...store.invocations.values()].filter((row) => row.runId === run.id).at(-1);
      if (searchFailed(last)) {
        await finishRun(store, run, keys, last);
        return;
      }
      const turns = store.stepsFor(run.id).filter((step) => step.type === "tool_invocation").length;
      if (turns < 3) {
        await runModelTurn(store, run, keys);
        return;
      }
      await finishRun(store, run, keys, last);
      return;
    }
    return;
  }
  const connectNext = await applyMissingConnect(store, run, keys);
  if (connectNext === "park" || connectNext === "done") {
    return;
  }
  await finishRun(store, run, keys, undefined, reply.text);
}

function searchFailed(last?: ToolInvocation): boolean {
  return Boolean(
    last?.tool === "web.search" &&
      last.result &&
      typeof last.result === "object" &&
      "error" in last.result &&
      (last.result as { error?: unknown }).error,
  );
}

function spokenFromLast(last?: ToolInvocation): string | undefined {
  if (searchFailed(last)) {
    return "Search failed. Try again.";
  }
  if (!last?.result || typeof last.result !== "object") {
    return undefined;
  }
  const row = last.result as Record<string, unknown>;
  if (typeof row.error === "string" && (row.error === "capability_missing" || row.error === "connector_missing")) {
    return "This service is not connected yet.";
  }
  if (row.status === "connect_required") {
    return "Connect the service to continue.";
  }
  if (row.status === "connected") {
    return `Connected ${String(row.provider ?? "the service")}.`;
  }
  if (last.tool === "task.create") {
    return `Created ${Number(row.count ?? 0)} inbox tasks for the Sales Manager.`;
  }
  if (Array.isArray(row.segments)) {
    return `Found ${Number(row.total ?? 0)} customers across ${row.segments.length} segments.`;
  }
  return undefined;
}

export async function finishRun(
  store: JarvisStore,
  run: Run,
  keys: RuntimeKeys,
  last?: ToolInvocation,
  spoken?: string,
): Promise<void> {
  const agent = store.agents.get(run.agentId);
  const handle = agent?.handle ?? "jarvis";
  const raw =
    spoken ??
    spokenFromLast(last) ??
    (last && last.result ? JSON.stringify(last.result) : "Done.");
  const text = raw.startsWith("@") ? raw : `@${handle} ${raw}`;
  const message = store.addMessage(run.threadId, "assistant", text);
  await persistThreadWrite(store, run.threadId, message);
  await emitDurable(store, run.id, "message_complete", {
    content: text,
    handle,
    agentName: agent?.name ?? "Jarvis",
  }, keys);
  await emitDurable(store, run.id, "run_state", { status: "completed" }, keys);
  store.setRunStatus(run.id, "completed", { clearLease: true });
  await persistRun(store, keys, run.id);
}

export async function onToolResultStored(
  store: JarvisStore,
  run: Run,
  keys: RuntimeKeys,
): Promise<void> {
  const last = [...store.invocations.values()]
    .filter((row) => row.runId === run.id)
    .at(-1);
  if (last && (last.status === "succeeded" || last.status === "failed")) {
    await recordActionOutcome(store, run, last);
    await emitDurable(store, run.id, "tool_finished", {
      toolInvocationId: last.id,
      result: last.result,
    }, keys);
    if (keys.modelApiKey) {
      await runModelTurn(store, run, keys);
      return;
    }
    await finishRun(store, run, keys, last);
    return;
  }
  await processRun(store, run, keys);
}
