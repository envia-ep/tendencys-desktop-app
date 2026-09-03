import type { JarvisEnv } from "./env.ts";
import type { JarvisStore } from "./store.ts";
import type {
  Approval,
  Device,
  GrantProjection,
  JarvisSession,
  Run,
  RunEvent,
  RunStatus,
  RunStep,
  ToolInvocation,
} from "./types.ts";

export type RuntimeRepo = {
  upsertDevice(row: Device): Promise<Device>;
  getDevice(id: string): Promise<Device | undefined>;
  upsertSession(row: JarvisSession): Promise<JarvisSession>;
  getSession(id: string): Promise<JarvisSession | undefined>;
  findReusableSession(deviceId: string): Promise<JarvisSession | undefined>;
  touchSession(sessionId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<JarvisSession | undefined>;
  upsertRun(row: Run): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  claimRun(workerId: string, leaseMs: number): Promise<Run | undefined>;
  renewLease(runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  wakeRun(runId: string): Promise<void>;
  upsertStep(row: RunStep): Promise<RunStep>;
  upsertInvocation(row: ToolInvocation): Promise<ToolInvocation>;
  upsertApproval(row: Approval): Promise<Approval>;
  upsertEvent(row: RunEvent): Promise<RunEvent>;
  eventsAfter(runId: string, afterSequence: number): Promise<RunEvent[]>;
  upsertGrant(row: GrantProjection): Promise<GrantProjection>;
  rememberNonce(nonce: string): Promise<boolean>;
  getIdempotency(key: string, scope: string): Promise<unknown | undefined>;
  storeIdempotency(key: string, scope: string, response: unknown, ttlMs: number): Promise<void>;
  hydrateStore(store: JarvisStore): Promise<void>;
};

export type RuntimeSnapshot = {
  devices: Device[];
  sessions: JarvisSession[];
  runs: Run[];
  steps: RunStep[];
  invocations: ToolInvocation[];
  approvals: Approval[];
  events: RunEvent[];
  grants: GrantProjection[];
  nonces: string[];
};

export function snapshotRuntime(store: JarvisStore): RuntimeSnapshot {
  return {
    devices: [...store.devices.values()].map((row) => ({ ...row })),
    sessions: [...store.sessions.values()].map((row) => ({ ...row })),
    runs: [...store.runs.values()].map((row) => ({ ...row })),
    steps: store.runSteps.map((row) => ({ ...row, payload: { ...row.payload } })),
    invocations: [...store.invocations.values()].map((row) => ({ ...row })),
    approvals: [...store.approvals.values()].map((row) => ({ ...row })),
    events: store.runEvents.map((row) => ({ ...row, payload: { ...row.payload } })),
    grants: [...store.grants.values()].map((row) => ({ ...row })),
    nonces: [...store.usedNonces],
  };
}

export function applyRuntimeSnapshot(store: JarvisStore, snap: RuntimeSnapshot): void {
  for (const row of snap.devices) {
    store.devices.set(row.id, { ...row });
  }
  for (const row of snap.sessions) {
    store.sessions.set(row.id, { ...row });
  }
  for (const row of snap.runs) {
    store.runs.set(row.id, { ...row });
  }
  store.runSteps.push(...snap.steps.map((row) => ({ ...row, payload: { ...row.payload } })));
  for (const row of snap.invocations) {
    store.invocations.set(row.id, { ...row });
  }
  for (const row of snap.approvals) {
    store.approvals.set(row.id, { ...row });
  }
  store.runEvents.push(...snap.events.map((row) => ({ ...row, payload: { ...row.payload } })));
  for (const row of snap.grants) {
    store.grants.set(row.grantId, { ...row });
  }
  for (const nonce of snap.nonces) {
    store.usedNonces.add(nonce);
  }
}

export function memoryRuntime(store: JarvisStore): RuntimeRepo {
  const idempotency = new Map<string, { response: unknown; expiresAt: number }>();

  return {
    async upsertDevice(row) {
      store.devices.set(row.id, row);
      return row;
    },
    async getDevice(id) {
      return store.devices.get(id);
    },
    async upsertSession(row) {
      store.sessions.set(row.id, row);
      return row;
    },
    async getSession(id) {
      return store.getSession(id);
    },
    async findReusableSession(deviceId) {
      const now = Date.now();
      return [...store.sessions.values()].find(
        (row) =>
          row.deviceId === deviceId &&
          !row.revokedAt &&
          Date.parse(row.expiresAt) > now,
      );
    },
    async touchSession(sessionId) {
      store.touchSession(sessionId);
    },
    async revokeSession(sessionId) {
      return store.revokeSession(sessionId);
    },
    async upsertRun(row) {
      store.runs.set(row.id, row);
      return row;
    },
    async getRun(id) {
      return store.getRun(id);
    },
    async claimRun(workerId, leaseMs) {
      return store.claimRun(workerId, leaseMs);
    },
    async renewLease(runId, workerId, leaseMs) {
      const run = store.getRun(runId);
      if (!run || run.workerId !== workerId) {
        return false;
      }
      run.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      return true;
    },
    async wakeRun(runId) {
      store.wakeRun(runId);
    },
    async upsertStep(row) {
      const index = store.runSteps.findIndex((step) => step.id === row.id);
      if (index >= 0) {
        store.runSteps[index] = row;
      } else {
        store.runSteps.push(row);
      }
      return row;
    },
    async upsertInvocation(row) {
      store.invocations.set(row.id, row);
      return row;
    },
    async upsertApproval(row) {
      store.approvals.set(row.id, row);
      return row;
    },
    async upsertEvent(row) {
      const index = store.runEvents.findIndex((event) => event.id === row.id);
      if (index >= 0) {
        store.runEvents[index] = row;
      } else {
        store.runEvents.push(row);
      }
      return row;
    },
    async eventsAfter(runId, afterSequence) {
      return store.eventsAfter(runId, afterSequence);
    },
    async upsertGrant(row) {
      return store.upsertGrant(row);
    },
    async rememberNonce(nonce) {
      return store.rememberNonce(nonce);
    },
    async getIdempotency(key, scope) {
      const row = idempotency.get(`${scope}:${key}`);
      if (!row || row.expiresAt < Date.now()) {
        return undefined;
      }
      return row.response;
    },
    async storeIdempotency(key, scope, response, ttlMs) {
      idempotency.set(`${scope}:${key}`, {
        response,
        expiresAt: Date.now() + ttlMs,
      });
    },
    async hydrateStore() {
      // already in the store
    },
  };
}

function asString(value: unknown): string {
  return String(value ?? "");
}

function asNullable(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function mapDevice(row: Record<string, unknown>): Device {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    orgId: asString(row.org_id),
    publicKey: asString(row.public_key),
    name: asString(row.name),
    accountsDeviceId: asNullable(row.accounts_device_id),
    createdAt: asString(row.created_at),
    revokedAt: asNullable(row.revoked_at),
  };
}

function mapSession(row: Record<string, unknown>): JarvisSession {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    orgId: asString(row.org_id),
    deviceId: asString(row.device_id),
    createdAt: asString(row.created_at),
    lastSeenAt: asString(row.last_seen_at),
    expiresAt: asString(row.expires_at),
    revokedAt: asNullable(row.revoked_at),
  };
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: asString(row.id),
    orgId: asString(row.org_id),
    actorId: asString(row.actor_id),
    threadId: asString(row.thread_id),
    agentId: asString(row.agent_id),
    agentVersion: asString(row.agent_version),
    taskId: asNullable(row.task_id),
    sessionId: asString(row.session_id),
    deviceId: asString(row.device_id),
    prompt: asString(row.prompt),
    status: asString(row.status) as RunStatus,
    attempt: Number(row.attempt ?? 0),
    workerId: asNullable(row.worker_id),
    leaseExpiresAt: asNullable(row.lease_expires_at),
    nextWakeAt: asNullable(row.next_wake_at),
    createdAt: asString(row.created_at),
  };
}

function mapStep(row: Record<string, unknown>): RunStep {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    sequence: Number(row.sequence),
    type: asString(row.type),
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: asString(row.created_at),
  };
}

function mapInvocation(row: Record<string, unknown>): ToolInvocation {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    runStepId: asString(row.run_step_id),
    sessionId: asString(row.session_id),
    deviceId: asString(row.device_id),
    requestId: asString(row.request_id),
    side: row.side === "native" ? "native" : "cloud",
    tool: asString(row.tool),
    arguments: (row.arguments as Record<string, unknown>) ?? {},
    argsHash: asString(row.args_hash),
    status: asString(row.status) as ToolInvocation["status"],
    result: row.result ?? null,
    argumentsSealed: row.arguments_sealed ? asString(row.arguments_sealed) : null,
    resultSealed: row.result_sealed ? asString(row.result_sealed) : null,
    grantId: asNullable(row.grant_id),
    connectorVersionId: asNullable(row.connector_version_id),
    capabilityVersionId: asNullable(row.capability_version_id),
    nonce: asNullable(row.nonce),
    expiresAt: asNullable(row.expires_at),
    createdAt: asString(row.created_at),
  };
}

function mapApproval(row: Record<string, unknown>): Approval {
  return {
    id: asString(row.id),
    toolInvocationId: asString(row.tool_invocation_id),
    tool: asString(row.tool),
    argsHash: asString(row.args_hash),
    agentVersion: asString(row.agent_version),
    runId: asString(row.run_id),
    expiresAt: asString(row.expires_at),
    decidedAt: asNullable(row.decided_at),
    decision: asString(row.decision) as Approval["decision"],
  };
}

function mapEvent(row: Record<string, unknown>): RunEvent {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    sequence: Number(row.sequence),
    eventType: asString(row.event_type),
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: asString(row.created_at),
  };
}

function mapGrant(row: Record<string, unknown>): GrantProjection {
  return {
    grantId: asString(row.grant_id),
    orgId: asString(row.org_id),
    deviceId: asString(row.device_id),
    capability: asString(row.capability),
    expiresAt: asNullable(row.expires_at),
    revokedAt: asNullable(row.revoked_at),
  };
}

function deviceRow(row: Device) {
  return {
    id: row.id,
    user_id: row.userId,
    org_id: row.orgId,
    public_key: row.publicKey,
    name: row.name,
    accounts_device_id: row.accountsDeviceId,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

function sessionRow(row: JarvisSession) {
  return {
    id: row.id,
    user_id: row.userId,
    org_id: row.orgId,
    device_id: row.deviceId,
    created_at: row.createdAt,
    last_seen_at: row.lastSeenAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
  };
}

function runRow(row: Run) {
  return {
    id: row.id,
    org_id: row.orgId,
    actor_id: row.actorId,
    thread_id: row.threadId,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    task_id: row.taskId,
    session_id: row.sessionId,
    device_id: row.deviceId,
    prompt: row.prompt,
    status: row.status,
    attempt: row.attempt,
    worker_id: row.workerId,
    lease_expires_at: row.leaseExpiresAt,
    next_wake_at: row.nextWakeAt,
    created_at: row.createdAt,
  };
}

function stepRow(row: RunStep) {
  return {
    id: row.id,
    run_id: row.runId,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    created_at: row.createdAt,
  };
}

function invocationRow(row: ToolInvocation) {
  return {
    id: row.id,
    run_id: row.runId,
    run_step_id: row.runStepId,
    session_id: row.sessionId,
    device_id: row.deviceId,
    request_id: row.requestId,
    side: row.side,
    tool: row.tool,
    arguments: row.arguments,
    args_hash: row.argsHash,
    status: row.status,
    result: row.result,
    arguments_sealed: row.argumentsSealed ?? null,
    result_sealed: row.resultSealed ?? null,
    grant_id: row.grantId,
    connector_version_id: row.connectorVersionId ?? null,
    capability_version_id: row.capabilityVersionId ?? null,
    nonce: row.nonce,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}

function approvalRow(row: Approval) {
  return {
    id: row.id,
    tool_invocation_id: row.toolInvocationId,
    tool: row.tool,
    args_hash: row.argsHash,
    agent_version: row.agentVersion,
    run_id: row.runId,
    expires_at: row.expiresAt,
    decided_at: row.decidedAt,
    decision: row.decision,
  };
}

function eventRow(row: RunEvent) {
  return {
    id: row.id,
    run_id: row.runId,
    sequence: row.sequence,
    event_type: row.eventType,
    payload: row.payload,
    created_at: row.createdAt,
  };
}

function grantRow(row: GrantProjection) {
  return {
    grant_id: row.grantId,
    org_id: row.orgId,
    device_id: row.deviceId,
    capability: row.capability,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
  };
}

export function createPostgresRuntime(env: JarvisEnv, store: JarvisStore): RuntimeRepo | null {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return null;
  }
  const base = `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation,resolution=merge-duplicates",
  };

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>[]> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[jarvis/runtime] ${path} ${response.status} ${text}`);
    }
    if (response.status === 204) {
      return [];
    }
    const body = await response.json();
    return Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : [body as Record<string, unknown>];
  }

  async function upsert(table: string, conflict: string, row: unknown): Promise<Record<string, unknown> | undefined> {
    const [saved] = await request(`/${table}?on_conflict=${conflict}`, {
      method: "POST",
      body: JSON.stringify(row),
    });
    return saved;
  }

  return {
    async upsertDevice(row) {
      const saved = await upsert("devices", "id", deviceRow(row));
      const mapped = saved ? mapDevice(saved) : row;
      store.devices.set(mapped.id, mapped);
      return mapped;
    },
    async getDevice(id) {
      const cached = store.devices.get(id);
      if (cached) {
        return cached;
      }
      const rows = await request(`/devices?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "GET",
      });
      if (!rows[0]) {
        return undefined;
      }
      const mapped = mapDevice(rows[0]);
      store.devices.set(mapped.id, mapped);
      return mapped;
    },
    async upsertSession(row) {
      const saved = await upsert("jarvis_sessions", "id", sessionRow(row));
      const mapped = saved ? mapSession(saved) : row;
      store.sessions.set(mapped.id, mapped);
      return mapped;
    },
    async getSession(id) {
      const cached = store.getSession(id);
      if (cached) {
        return cached;
      }
      const rows = await request(`/jarvis_sessions?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "GET",
      });
      if (!rows[0]) {
        return undefined;
      }
      const mapped = mapSession(rows[0]);
      store.sessions.set(mapped.id, mapped);
      return mapped;
    },
    async findReusableSession(deviceId) {
      const nowMs = Date.now();
      const cached = [...store.sessions.values()].find(
        (row) =>
          row.deviceId === deviceId &&
          !row.revokedAt &&
          Date.parse(row.expiresAt) > nowMs,
      );
      if (cached) {
        return cached;
      }
      const now = new Date().toISOString();
      const rows = await request(
        `/jarvis_sessions?device_id=eq.${encodeURIComponent(deviceId)}&revoked_at=is.null&expires_at=gt.${encodeURIComponent(now)}&order=created_at.desc&limit=1`,
        { method: "GET" },
      );
      if (!rows[0]) {
        return undefined;
      }
      const mapped = mapSession(rows[0]);
      store.sessions.set(mapped.id, mapped);
      return mapped;
    },
    async touchSession(sessionId) {
      store.touchSession(sessionId);
      const session = store.getSession(sessionId);
      if (session) {
        await upsert("jarvis_sessions", "id", sessionRow(session));
      }
    },
    async revokeSession(sessionId) {
      const session = store.revokeSession(sessionId);
      if (session) {
        await upsert("jarvis_sessions", "id", sessionRow(session));
      }
      return session;
    },
    async upsertRun(row) {
      const saved = await upsert("runs", "id", runRow(row));
      const mapped = saved ? mapRun(saved) : row;
      store.runs.set(mapped.id, mapped);
      return mapped;
    },
    async getRun(id) {
      const cached = store.getRun(id);
      if (cached) {
        return cached;
      }
      const rows = await request(`/runs?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "GET",
      });
      if (!rows[0]) {
        return undefined;
      }
      const mapped = mapRun(rows[0]);
      store.runs.set(mapped.id, mapped);
      return mapped;
    },
    async claimRun(workerId, leaseMs) {
      const rows = await request("/rpc/claim_jarvis_run", {
        method: "POST",
        body: JSON.stringify({ p_worker_id: workerId, p_lease_ms: leaseMs }),
      });
      if (!rows[0]) {
        return undefined;
      }
      const mapped = mapRun(rows[0]);
      store.runs.set(mapped.id, mapped);
      return mapped;
    },
    async renewLease(runId, workerId, leaseMs) {
      const rows = await request("/rpc/renew_jarvis_lease", {
        method: "POST",
        body: JSON.stringify({
          p_run_id: runId,
          p_worker_id: workerId,
          p_lease_ms: leaseMs,
        }),
      });
      const first = rows[0];
      const ok = first?.renew_jarvis_lease === true || Boolean(first);
      if (ok) {
        const run = store.getRun(runId);
        if (run) {
          run.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
        }
      }
      return Boolean(ok);
    },
    async wakeRun(runId) {
      store.wakeRun(runId);
      const run = store.getRun(runId);
      if (run) {
        await upsert("runs", "id", runRow(run));
      }
    },
    async upsertStep(row) {
      const saved = await upsert("run_steps", "id", stepRow(row));
      const mapped = saved ? mapStep(saved) : row;
      const index = store.runSteps.findIndex((step) => step.id === mapped.id);
      if (index >= 0) {
        store.runSteps[index] = mapped;
      } else {
        store.runSteps.push(mapped);
      }
      return mapped;
    },
    async upsertInvocation(row) {
      const saved = await upsert("tool_invocations", "id", invocationRow(row));
      const mapped = saved ? mapInvocation(saved) : row;
      store.invocations.set(mapped.id, mapped);
      return mapped;
    },
    async upsertApproval(row) {
      const saved = await upsert("approvals", "id", approvalRow(row));
      const mapped = saved ? mapApproval(saved) : row;
      store.approvals.set(mapped.id, mapped);
      return mapped;
    },
    async upsertEvent(row) {
      const saved = await upsert("run_events", "id", eventRow(row));
      const mapped = saved ? mapEvent(saved) : row;
      const index = store.runEvents.findIndex((event) => event.id === mapped.id);
      if (index >= 0) {
        store.runEvents[index] = mapped;
      } else {
        store.runEvents.push(mapped);
      }
      return mapped;
    },
    async eventsAfter(runId, afterSequence) {
      const rows = await request(
        `/run_events?run_id=eq.${encodeURIComponent(runId)}&sequence=gt.${afterSequence}&order=sequence.asc`,
        { method: "GET" },
      );
      return rows.map(mapEvent);
    },
    async upsertGrant(row) {
      const saved = await upsert("grant_projections", "grant_id", grantRow(row));
      const mapped = saved ? mapGrant(saved) : row;
      store.grants.set(mapped.grantId, mapped);
      return mapped;
    },
    async rememberNonce(nonce) {
      if (store.usedNonces.has(nonce)) {
        return false;
      }
      const response = await fetch(`${base}/used_nonces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ nonce }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 409) {
        return false;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`[jarvis/runtime] used_nonces ${response.status} ${text}`);
      }
      store.usedNonces.add(nonce);
      return true;
    },
    async getIdempotency(key, scope) {
      const rows = await request(
        `/idempotency_keys?key=eq.${encodeURIComponent(key)}&scope=eq.${encodeURIComponent(scope)}&select=*`,
        { method: "GET" },
      );
      const row = rows[0];
      if (!row || Date.parse(asString(row.expires_at)) < Date.now()) {
        return undefined;
      }
      return row.response;
    },
    async storeIdempotency(key, scope, response, ttlMs) {
      await upsert("idempotency_keys", "key,scope", {
        key,
        scope,
        response,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      });
    },
    async hydrateStore(target) {
      applyRuntimeSnapshot(target, {
        devices: (await request("/devices?select=*", { method: "GET" })).map(mapDevice),
        sessions: (await request("/jarvis_sessions?select=*", { method: "GET" })).map(mapSession),
        runs: (await request("/runs?select=*", { method: "GET" })).map(mapRun),
        steps: (await request("/run_steps?select=*&order=sequence.asc", { method: "GET" })).map(mapStep),
        invocations: (await request("/tool_invocations?select=*", { method: "GET" })).map(mapInvocation),
        approvals: (await request("/approvals?select=*", { method: "GET" })).map(mapApproval),
        events: (await request("/run_events?select=*&order=sequence.asc", { method: "GET" })).map(mapEvent),
        grants: (await request("/grant_projections?select=*", { method: "GET" })).map(mapGrant),
        nonces: (await request("/used_nonces?select=nonce", { method: "GET" })).map((row) =>
          asString(row.nonce),
        ),
      });
    },
  };
}
