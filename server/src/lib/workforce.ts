import type { JarvisEnv } from "./env.ts";
import { id } from "./ids.ts";
import type { JarvisStore } from "./store.ts";
import type {
  ContextCompilation,
  Objective,
  ObjectiveStatus,
  Task,
  TaskEvent,
  TaskEventType,
  TaskPriority,
  TaskStatus,
} from "./types.ts";

const OPEN_INBOX: TaskStatus[] = ["assigned", "in_progress", "blocked"];
const ACTIVE_RUN = new Set(["queued", "running", "waiting_for_local_tool", "waiting_for_approval", "waiting_for_connect"]);
const TERMINAL_RUN = new Set(["completed", "failed"]);

function nowIso(): string {
  return new Date().toISOString();
}

export type WorkforceRepo = {
  createObjective(row: Objective): Promise<Objective>;
  getObjective(id: string): Promise<Objective | undefined>;
  listObjectives(orgId: string): Promise<Objective[]>;
  createTask(row: Task): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  listTasks(filter: {
    orgId: string;
    objectiveId?: string;
    assigneePrincipalId?: string;
    status?: TaskStatus | TaskStatus[];
  }): Promise<Task[]>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  addEvent(row: TaskEvent): Promise<TaskEvent>;
  listEvents(taskId: string): Promise<TaskEvent[]>;
  saveCompilation(row: ContextCompilation): Promise<void>;
};

export function memoryWorkforce(): WorkforceRepo {
  const objectives = new Map<string, Objective>();
  const tasks = new Map<string, Task>();
  const events: TaskEvent[] = [];
  const compilations = new Map<string, ContextCompilation>();

  return {
    async createObjective(row) {
      objectives.set(row.id, row);
      return row;
    },
    async getObjective(objectiveId) {
      return objectives.get(objectiveId);
    },
    async listObjectives(orgId) {
      return [...objectives.values()].filter((row) => row.orgId === orgId);
    },
    async createTask(row) {
      tasks.set(row.id, row);
      return row;
    },
    async getTask(taskId) {
      return tasks.get(taskId);
    },
    async listTasks(filter) {
      const statuses = filter.status
        ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
        : null;
      return [...tasks.values()].filter((row) => {
        if (row.orgId !== filter.orgId) {
          return false;
        }
        if (filter.objectiveId && row.objectiveId !== filter.objectiveId) {
          return false;
        }
        if (filter.assigneePrincipalId && row.assigneePrincipalId !== filter.assigneePrincipalId) {
          return false;
        }
        if (statuses && !statuses.has(row.status)) {
          return false;
        }
        return true;
      });
    },
    async updateTask(taskId, patch) {
      const current = tasks.get(taskId);
      if (!current) {
        throw new Error("task not found");
      }
      const next = { ...current, ...patch, id: current.id, orgId: current.orgId, updatedAt: nowIso() };
      tasks.set(taskId, next);
      return next;
    },
    async addEvent(row) {
      events.push(row);
      return row;
    },
    async listEvents(taskId) {
      return events
        .filter((row) => row.taskId === taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async saveCompilation(row) {
      compilations.set(row.id, row);
    },
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mapObjective(row: Record<string, unknown>): Objective {
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? row.orgId),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: row.status === "done" ? "done" : "open",
    projectUnitId: row.project_unit_id
      ? String(row.project_unit_id)
      : row.projectUnitId
        ? String(row.projectUnitId)
        : null,
  };
}

function mapTask(row: Record<string, unknown>): Task {
  const priority = String(row.priority ?? "normal");
  const status = String(row.status ?? "planned");
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? row.orgId),
    objectiveId: row.objective_id
      ? String(row.objective_id)
      : row.objectiveId
        ? String(row.objectiveId)
        : null,
    name: String(row.name),
    description: String(row.description ?? ""),
    priority:
      priority === "low" || priority === "high" || priority === "urgent" ? priority : "normal",
    assigneePrincipalId: row.assignee_principal_id
      ? String(row.assignee_principal_id)
      : row.assigneePrincipalId
        ? String(row.assigneePrincipalId)
        : null,
    status: (["planned", "assigned", "in_progress", "blocked", "completed", "cancelled"].includes(
      status,
    )
      ? status
      : "planned") as TaskStatus,
    createdByPrincipalId: row.created_by_principal_id
      ? String(row.created_by_principal_id)
      : row.createdByPrincipalId
        ? String(row.createdByPrincipalId)
        : null,
    dueAt: row.due_at ? String(row.due_at) : row.dueAt ? String(row.dueAt) : null,
    projectUnitId: row.project_unit_id
      ? String(row.project_unit_id)
      : row.projectUnitId
        ? String(row.projectUnitId)
        : null,
    resultSummary: row.result_summary
      ? String(row.result_summary)
      : row.resultSummary
        ? String(row.resultSummary)
        : null,
    createdAt: String(row.created_at ?? row.createdAt ?? nowIso()),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function taskRow(row: Task): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.orgId,
    objective_id: row.objectiveId,
    name: row.name,
    description: row.description,
    priority: row.priority,
    assignee_principal_id: row.assigneePrincipalId,
    status: row.status,
    created_by_principal_id: row.createdByPrincipalId,
    due_at: row.dueAt,
    project_unit_id: row.projectUnitId,
    result_summary: row.resultSummary,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function objectiveRow(row: Objective): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.orgId,
    name: row.name,
    description: row.description,
    status: row.status,
    project_unit_id: row.projectUnitId,
  };
}

function eventRow(row: TaskEvent): Record<string, unknown> {
  return {
    id: row.id,
    task_id: row.taskId,
    type: row.type,
    actor_principal_id: row.actorPrincipalId,
    run_id: row.runId,
    from_status: row.fromStatus,
    to_status: row.toStatus,
    metadata: row.metadata,
    created_at: row.createdAt,
  };
}

function compilationRow(row: ContextCompilation): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.runId,
    run_step_id: row.runStepId,
    compiler_version: row.compilerVersion,
    agent_version_id: row.agentVersionId,
    usage: row.usage,
    provenance: row.provenance,
    presented_tools: row.presentedTools,
    prompt_hash: row.promptHash,
    context_hash: row.contextHash,
    created_at: row.createdAt,
  };
}

export function createPostgresWorkforce(env: JarvisEnv): WorkforceRepo | null {
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
      throw new Error(`[jarvis/workforce] ${path} ${response.status} ${text}`);
    }
    if (response.status === 204) {
      return [];
    }
    const body = await response.json();
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : [body as Record<string, unknown>];
  }

  return {
    async createObjective(row) {
      const [saved] = await request("/objectives?on_conflict=id", {
        method: "POST",
        body: JSON.stringify(objectiveRow(row)),
      });
      return saved ? mapObjective(saved) : row;
    },
    async getObjective(objectiveId) {
      const rows = await request(`/objectives?id=eq.${encodeURIComponent(objectiveId)}&select=*`, {
        method: "GET",
      });
      return rows[0] ? mapObjective(rows[0]) : undefined;
    },
    async listObjectives(orgId) {
      const rows = await request(`/objectives?org_id=eq.${encodeURIComponent(orgId)}&select=*`, {
        method: "GET",
      });
      return rows.map(mapObjective);
    },
    async createTask(row) {
      const [saved] = await request("/tasks?on_conflict=id", {
        method: "POST",
        body: JSON.stringify(taskRow(row)),
      });
      return saved ? mapTask(saved) : row;
    },
    async getTask(taskId) {
      const rows = await request(`/tasks?id=eq.${encodeURIComponent(taskId)}&select=*`, {
        method: "GET",
      });
      return rows[0] ? mapTask(rows[0]) : undefined;
    },
    async listTasks(filter) {
      const params = [`org_id=eq.${encodeURIComponent(filter.orgId)}`, "select=*"];
      if (filter.objectiveId) {
        params.push(`objective_id=eq.${encodeURIComponent(filter.objectiveId)}`);
      }
      if (filter.assigneePrincipalId) {
        params.push(`assignee_principal_id=eq.${encodeURIComponent(filter.assigneePrincipalId)}`);
      }
      if (filter.status) {
        const list = Array.isArray(filter.status) ? filter.status : [filter.status];
        params.push(`status=in.(${list.join(",")})`);
      }
      const rows = await request(`/tasks?${params.join("&")}`, { method: "GET" });
      return rows.map(mapTask);
    },
    async updateTask(taskId, patch) {
      const current = await this.getTask(taskId);
      if (!current) {
        throw new Error("task not found");
      }
      const next = { ...current, ...patch, id: current.id, orgId: current.orgId, updatedAt: nowIso() };
      const [saved] = await request(`/tasks?id=eq.${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify(taskRow(next)),
      });
      return saved ? mapTask(saved) : next;
    },
    async addEvent(row) {
      await request("/task_events?on_conflict=id", {
        method: "POST",
        body: JSON.stringify(eventRow(row)),
      });
      return row;
    },
    async listEvents(taskId) {
      const rows = await request(
        `/task_events?task_id=eq.${encodeURIComponent(taskId)}&select=*&order=created_at.asc`,
        { method: "GET" },
      );
      return rows.map((row) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        type: String(row.type) as TaskEventType,
        actorPrincipalId: row.actor_principal_id ? String(row.actor_principal_id) : null,
        runId: row.run_id ? String(row.run_id) : null,
        fromStatus: (row.from_status as TaskStatus | null) ?? null,
        toStatus: (row.to_status as TaskStatus | null) ?? null,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        createdAt: String(row.created_at ?? nowIso()),
      }));
    },
    async saveCompilation(row) {
      await request("/context_compilations?on_conflict=id", {
        method: "POST",
        body: JSON.stringify({
          ...compilationRow(row),
          presented_tools: asStringArray(row.presentedTools),
        }),
      });
    },
  };
}

export function isAgentPrincipal(store: JarvisStore, principalId: string | null): boolean {
  if (!principalId) {
    return false;
  }
  return store.principals.get(principalId)?.type === "agent";
}

export function activeRunForTask(store: JarvisStore, taskId: string) {
  return [...store.runs.values()].find(
    (run) => run.taskId === taskId && ACTIVE_RUN.has(run.status),
  );
}

export function lastRunForTask(store: JarvisStore, taskId: string) {
  return [...store.runs.values()]
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

export async function recordTaskEvent(
  repo: WorkforceRepo,
  input: {
    taskId: string;
    type: TaskEventType;
    actorPrincipalId: string | null;
    runId?: string | null;
    fromStatus?: TaskStatus | null;
    toStatus?: TaskStatus | null;
    metadata?: Record<string, unknown>;
  },
): Promise<TaskEvent> {
  return repo.addEvent({
    id: id("tev"),
    taskId: input.taskId,
    type: input.type,
    actorPrincipalId: input.actorPrincipalId,
    runId: input.runId ?? null,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    metadata: input.metadata ?? {},
    createdAt: nowIso(),
  });
}

export function newObjective(input: {
  orgId: string;
  name: string;
  description?: string;
  status?: ObjectiveStatus;
  projectUnitId?: string | null;
}): Objective {
  return {
    id: id("obj"),
    orgId: input.orgId,
    name: input.name,
    description: input.description ?? "",
    status: input.status ?? "open",
    projectUnitId: input.projectUnitId ?? null,
  };
}

export function newTask(input: {
  orgId: string;
  name: string;
  description?: string;
  objectiveId?: string | null;
  priority?: TaskPriority;
  assigneePrincipalId?: string | null;
  createdByPrincipalId?: string | null;
  dueAt?: string | null;
  projectUnitId?: string | null;
}): Task {
  const assigned = Boolean(input.assigneePrincipalId);
  const created = nowIso();
  return {
    id: id("tsk"),
    orgId: input.orgId,
    objectiveId: input.objectiveId ?? null,
    name: input.name,
    description: input.description ?? "",
    priority: input.priority ?? "normal",
    assigneePrincipalId: input.assigneePrincipalId ?? null,
    status: assigned ? "assigned" : "planned",
    createdByPrincipalId: input.createdByPrincipalId ?? null,
    dueAt: input.dueAt ?? null,
    projectUnitId: input.projectUnitId ?? null,
    resultSummary: null,
    createdAt: created,
    updatedAt: created,
  };
}

export type DispatchAuth = {
  userId: string;
  orgId: string;
  sessionId: string;
  deviceId: string;
};

export function dispatchTaskRun(
  store: JarvisStore,
  task: Task,
  auth: DispatchAuth,
): { runId: string; created: boolean; threadId: string } {
  const existing = activeRunForTask(store, task.id);
  if (existing) {
    return { runId: existing.id, created: false, threadId: existing.threadId };
  }
  const assignee = task.assigneePrincipalId
    ? store.principals.get(task.assigneePrincipalId)
    : undefined;
  const seeded = store.seedDefaultJarvis(auth.orgId);
  const agentId = assignee?.agentId ?? seeded.agent.id;
  const agent = store.agents.get(agentId) ?? seeded.agent;
  const version = store.latestVersion(agent.id);
  if (!version) {
    throw new Error("Agent version not found");
  }
  const prior = lastRunForTask(store, task.id);
  const thread =
    prior && store.threads.get(prior.threadId)
      ? store.threads.get(prior.threadId)!
      : store.createThread({
          orgId: auth.orgId,
          actorId: auth.userId,
          agentId: agent.id,
          title: task.name,
        });
  const run = store.createRun({
    id: id("run"),
    orgId: auth.orgId,
    actorId: auth.userId,
    threadId: thread.id,
    agentId: agent.id,
    agentVersion: version.id,
    sessionId: auth.sessionId,
    deviceId: auth.deviceId,
    prompt: task.name,
    taskId: task.id,
  });
  return { runId: run.id, created: true, threadId: thread.id };
}

export async function createObjectiveRecord(
  store: JarvisStore,
  repo: WorkforceRepo,
  input: {
    orgId: string;
    name: string;
    description?: string;
    projectUnitId?: string | null;
  },
): Promise<Objective> {
  const objective = newObjective(input);
  await repo.createObjective(objective);
  store.objectives.set(objective.id, objective);
  store.bumpGraphRevision(input.orgId);
  return objective;
}

export async function createTaskRecord(
  store: JarvisStore,
  repo: WorkforceRepo,
  input: {
    orgId: string;
    name: string;
    description?: string;
    objectiveId?: string | null;
    priority?: TaskPriority;
    assigneePrincipalId?: string | null;
    createdByPrincipalId?: string | null;
    dueAt?: string | null;
    projectUnitId?: string | null;
  },
  auth: DispatchAuth,
): Promise<{ task: Task; runId: string | null; created: boolean }> {
  const task = newTask(input);
  await repo.createTask(task);
  await recordTaskEvent(repo, {
    taskId: task.id,
    type: "created",
    actorPrincipalId: input.createdByPrincipalId ?? null,
    toStatus: task.status,
  });
  if (task.assigneePrincipalId) {
    await recordTaskEvent(repo, {
      taskId: task.id,
      type: "assigned",
      actorPrincipalId: input.createdByPrincipalId ?? null,
      toStatus: "assigned",
      metadata: { assigneePrincipalId: task.assigneePrincipalId },
    });
  }
  if (isAgentPrincipal(store, task.assigneePrincipalId)) {
    const dispatched = dispatchTaskRun(store, task, auth);
    if (dispatched.created) {
      await recordTaskEvent(repo, {
        taskId: task.id,
        type: "dispatched",
        actorPrincipalId: input.createdByPrincipalId ?? null,
        runId: dispatched.runId,
      });
    }
    return { task, runId: dispatched.runId, created: dispatched.created };
  }
  return { task, runId: null, created: false };
}

export async function assignTask(
  store: JarvisStore,
  repo: WorkforceRepo,
  taskId: string,
  assigneePrincipalId: string | null,
  actorPrincipalId: string | null,
  auth: DispatchAuth,
): Promise<{ task: Task; runId: string | null; created: boolean }> {
  const current = await repo.getTask(taskId);
  if (!current || current.orgId !== auth.orgId) {
    throw new Error("task not found");
  }
  const fromStatus = current.status;
  const nextStatus: TaskStatus = assigneePrincipalId
    ? current.status === "planned"
      ? "assigned"
      : current.status
    : current.status === "assigned"
      ? "planned"
      : current.status;
  const task = await repo.updateTask(taskId, {
    assigneePrincipalId,
    status: nextStatus,
  });
  await recordTaskEvent(repo, {
    taskId,
    type: assigneePrincipalId ? "assigned" : "unassigned",
    actorPrincipalId,
    fromStatus,
    toStatus: task.status,
    metadata: { assigneePrincipalId },
  });
  if (isAgentPrincipal(store, assigneePrincipalId)) {
    const dispatched = dispatchTaskRun(store, task, auth);
    if (dispatched.created) {
      await recordTaskEvent(repo, {
        taskId,
        type: "dispatched",
        actorPrincipalId,
        runId: dispatched.runId,
      });
    }
    return { task, runId: dispatched.runId, created: dispatched.created };
  }
  return { task, runId: null, created: false };
}

export async function startTask(
  store: JarvisStore,
  repo: WorkforceRepo,
  taskId: string,
  actorPrincipalId: string | null,
  auth: DispatchAuth,
): Promise<{ runId: string; created: boolean; threadId: string }> {
  const task = await repo.getTask(taskId);
  if (!task || task.orgId !== auth.orgId) {
    throw new Error("task not found");
  }
  const dispatched = dispatchTaskRun(store, task, auth);
  if (dispatched.created) {
    await recordTaskEvent(repo, {
      taskId,
      type: "dispatched",
      actorPrincipalId,
      runId: dispatched.runId,
    });
  }
  return dispatched;
}

export async function retryTask(
  store: JarvisStore,
  repo: WorkforceRepo,
  taskId: string,
  actorPrincipalId: string | null,
  auth: DispatchAuth,
): Promise<{ runId: string; created: boolean; threadId: string }> {
  const task = await repo.getTask(taskId);
  if (!task || task.orgId !== auth.orgId) {
    throw new Error("task not found");
  }
  const last = lastRunForTask(store, taskId);
  if (last && !TERMINAL_RUN.has(last.status)) {
    return { runId: last.id, created: false, threadId: last.threadId };
  }
  if (task.status === "blocked" || task.status === "completed") {
    await repo.updateTask(taskId, { status: "assigned" });
  }
  const dispatched = dispatchTaskRun(store, { ...task, status: "assigned" }, auth);
  if (dispatched.created) {
    await recordTaskEvent(repo, {
      taskId,
      type: "retried",
      actorPrincipalId,
      runId: dispatched.runId,
      fromStatus: task.status,
      toStatus: "assigned",
    });
  }
  return dispatched;
}

export async function markTaskStarted(
  repo: WorkforceRepo,
  taskId: string,
  runId: string,
): Promise<void> {
  const task = await repo.getTask(taskId);
  if (!task || task.status === "completed" || task.status === "cancelled") {
    return;
  }
  if (task.status !== "in_progress") {
    await repo.updateTask(taskId, { status: "in_progress" });
    await recordTaskEvent(repo, {
      taskId,
      type: "started",
      actorPrincipalId: task.assigneePrincipalId,
      runId,
      fromStatus: task.status,
      toStatus: "in_progress",
    });
  }
}

export async function markTaskBlocked(
  repo: WorkforceRepo,
  taskId: string,
  runId: string,
): Promise<void> {
  const task = await repo.getTask(taskId);
  if (!task || task.status === "completed" || task.status === "cancelled") {
    return;
  }
  await repo.updateTask(taskId, { status: "blocked" });
  await recordTaskEvent(repo, {
    taskId,
    type: "blocked",
    actorPrincipalId: task.assigneePrincipalId,
    runId,
    fromStatus: task.status,
    toStatus: "blocked",
  });
}

export async function completeCurrentTask(
  repo: WorkforceRepo,
  taskId: string,
  resultSummary: string,
  runId: string,
): Promise<Task> {
  const task = await repo.getTask(taskId);
  if (!task) {
    throw new Error("task not found");
  }
  const next = await repo.updateTask(taskId, {
    status: "completed",
    resultSummary,
  });
  await recordTaskEvent(repo, {
    taskId,
    type: "completed",
    actorPrincipalId: task.assigneePrincipalId,
    runId,
    fromStatus: task.status,
    toStatus: "completed",
    metadata: { resultSummary },
  });
  return next;
}

export async function updateCurrentTask(
  repo: WorkforceRepo,
  taskId: string,
  status: "blocked" | "in_progress",
  note: string | undefined,
  runId: string,
): Promise<Task> {
  const task = await repo.getTask(taskId);
  if (!task) {
    throw new Error("task not found");
  }
  const next = await repo.updateTask(taskId, { status });
  await recordTaskEvent(repo, {
    taskId,
    type: status === "blocked" ? "blocked" : "started",
    actorPrincipalId: task.assigneePrincipalId,
    runId,
    fromStatus: task.status,
    toStatus: status,
    metadata: note ? { note } : {},
  });
  return next;
}

export async function inboxForOrg(
  store: JarvisStore,
  repo: WorkforceRepo,
  orgId: string,
  agentId?: string,
) {
  const assigneePrincipalId = agentId
    ? [...store.principals.values()].find(
        (row) => row.orgId === orgId && row.agentId === agentId,
      )?.id
    : undefined;
  const items = await repo.listTasks({
    orgId,
    assigneePrincipalId,
    status: [...OPEN_INBOX, "completed"],
  });
  return items.map((task) => {
    const assignee = task.assigneePrincipalId
      ? store.principals.get(task.assigneePrincipalId)
      : undefined;
    const agent = assignee?.agentId ? store.agents.get(assignee.agentId) : undefined;
    const active = activeRunForTask(store, task.id);
    const last = lastRunForTask(store, task.id);
    return {
      task,
      assignee: assignee
        ? {
            id: assignee.id,
            type: assignee.type,
            displayName: assignee.displayName,
            handle: agent?.handle ?? null,
          }
        : null,
      activeRun: active
        ? { id: active.id, status: active.status }
        : null,
      lastRun: last ? { id: last.id, status: last.status } : null,
    };
  });
}
