import { cosine, embedText } from "./crypto.ts";
import { handleFromName, uniqueHandle } from "./handles.ts";
import { id } from "./ids.ts";
import { DEFAULT_JARVIS_TOOLS } from "./tools.ts";
import type {
  AccessGrant,
  ActionOutcome,
  Capability,
  Connector,
  Credential,
  ConnectSession,
  CustomTool,
  WebhookDelivery,
  IntegrationDraft,
  IntegrationSource,
  IntegrationValidation,
  IntegrationRecipe,
  ConnectorHealth,
  Agent,
  AgentRole,
  AgentSkill,
  AgentVersion,
  Approval,
  ApprovalDecision,
  CapabilityVersion,
  ConnectorVersion,
  AuditEvent,
  Device,
  GrantProjection,
  InvocationStatus,
  JarvisSession,
  Memory,
  MemoryScope,
  Message,
  Objective,
  ObjectiveOwner,
  Organization,
  OrganizationalUnit,
  PolicyOutcome,
  PolicyRecord,
  Principal,
  PrincipalRelationship,
  ProjectDetails,
  ProjectMembership,
  Role,
  RoleResponsibility,
  RoleSkill,
  Run,
  RunEvent,
  RunStatus,
  RunStep,
  Skill,
  SkillVersion,
  StudioProposal,
  Thread,
  ThreadSummary,
  ToolInvocation,
  TraceEvent,
  UnitMembership,
  Workflow,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function recencyWeight(createdAt: string): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(createdAt)) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

export class JarvisStore {
  persister: { upsert(table: string, row: unknown): Promise<void> } | null = null;

  async persist(table: string, row: unknown): Promise<void> {
    if (this.persister) {
      await this.persister.upsert(table, row);
    }
  }

  organizations = new Map<string, Organization>();
  memberships = new Map<string, { companyId: string; userId: string; createdAt: string }>();
  devices = new Map<string, Device>();
  sessions = new Map<string, JarvisSession>();
  agents = new Map<string, Agent>();
  agentVersions = new Map<string, AgentVersion>();
  threads = new Map<string, Thread>();
  messages: Message[] = [];
  runs = new Map<string, Run>();
  runSteps: RunStep[] = [];
  invocations = new Map<string, ToolInvocation>();
  approvals = new Map<string, Approval>();
  memories: Memory[] = [];
  actionOutcomes: ActionOutcome[] = [];
  threadSummaries = new Map<string, ThreadSummary>();
  runEvents: RunEvent[] = [];
  auditEvents: AuditEvent[] = [];
  traceEvents: TraceEvent[] = [];
  grants = new Map<string, GrantProjection>();
  usedNonces = new Set<string>();
  principals = new Map<string, Principal>();
  units = new Map<string, OrganizationalUnit>();
  projectDetails = new Map<string, ProjectDetails>();
  roles = new Map<string, Role>();
  skills = new Map<string, Skill>();
  skillVersions = new Map<string, SkillVersion>();
  unitMemberships = new Map<string, UnitMembership>();
  agentRoles = new Map<string, AgentRole>();
  agentSkills = new Map<string, AgentSkill>();
  roleSkills = new Map<string, RoleSkill>();
  roleResponsibilities = new Map<string, RoleResponsibility>();
  principalRelationships = new Map<string, PrincipalRelationship>();
  projectMemberships = new Map<string, ProjectMembership>();
  objectives = new Map<string, Objective>();
  objectiveOwners = new Map<string, ObjectiveOwner>();
  workflows = new Map<string, Workflow>();
  accessGrants = new Map<string, AccessGrant>();
  policyRecords = new Map<string, PolicyRecord>();
  studioProposals = new Map<string, StudioProposal>();
  credentials = new Map<string, Credential>();
  connectors = new Map<string, Connector>();
  connectorVersions = new Map<string, ConnectorVersion>();
  capabilities = new Map<string, Capability>();
  capabilityVersions = new Map<string, CapabilityVersion>();
  customTools = new Map<string, CustomTool>();
  webhookDeliveries = new Map<string, WebhookDelivery>();
  connectSessions = new Map<string, ConnectSession>();
  integrationDrafts = new Map<string, IntegrationDraft>();
  integrationSources = new Map<string, IntegrationSource>();
  integrationValidations = new Map<string, IntegrationValidation>();
  connectorHealth = new Map<string, ConnectorHealth>();
  /** Platform-wide learned "how to connect" library, keyed by product slug. */
  integrationRecipes = new Map<string, IntegrationRecipe>();

  ensureOrg(companyId: string, userId: string, name?: string): Organization {
    let org = this.organizations.get(companyId);
    if (!org) {
      org = {
        companyId,
        name: name ?? companyId,
        graphRevision: 0,
        createdAt: nowIso(),
      };
      this.organizations.set(companyId, org);
    }
    const key = `${companyId}:${userId}`;
    if (!this.memberships.has(key)) {
      this.memberships.set(key, { companyId, userId, createdAt: nowIso() });
    }
    return org;
  }

  getOrg(orgId: string): Organization | undefined {
    return this.organizations.get(orgId);
  }

  bumpGraphRevision(orgId: string): number {
    const org = this.organizations.get(orgId);
    if (!org) {
      return 0;
    }
    org.graphRevision += 1;
    return org.graphRevision;
  }

  upsertDevice(input: {
    id: string;
    userId: string;
    orgId: string;
    publicKey: string;
    name: string;
    accountsDeviceId?: string | null;
  }): Device {
    const existing = this.devices.get(input.id);
    if (existing && existing.revokedAt) {
      throw new Error("device revoked");
    }
    if (existing) {
      existing.publicKey = input.publicKey;
      existing.name = input.name;
      return existing;
    }
    const device: Device = {
      id: input.id,
      userId: input.userId,
      orgId: input.orgId,
      publicKey: input.publicKey,
      name: input.name,
      accountsDeviceId: input.accountsDeviceId ?? null,
      createdAt: nowIso(),
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    return device;
  }

  createSession(input: {
    userId: string;
    orgId: string;
    deviceId: string;
    ttlMs: number;
  }): JarvisSession {
    const created = nowIso();
    const session: JarvisSession = {
      id: id("ses"),
      userId: input.userId,
      orgId: input.orgId,
      deviceId: input.deviceId,
      createdAt: created,
      lastSeenAt: created,
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): JarvisSession | undefined {
    return this.sessions.get(sessionId);
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = nowIso();
    }
  }

  revokeSession(sessionId: string): JarvisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) {
      session.revokedAt = nowIso();
    }
    return session;
  }

  revokeDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.revokedAt = nowIso();
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && !session.revokedAt) {
        session.revokedAt = nowIso();
      }
    }
  }

  listAgents(orgId: string): Agent[] {
    return [...this.agents.values()].filter((agent) => agent.orgId === orgId);
  }

  latestVersion(agentId: string): AgentVersion | undefined {
    return [...this.agentVersions.values()]
      .filter((row) => row.agentId === agentId)
      .sort((a, b) => b.version - a.version)[0];
  }

  getVersion(versionId: string): AgentVersion | undefined {
    return this.agentVersions.get(versionId);
  }

  createAgent(input: {
    orgId: string;
    name: string;
    identity: string;
    jobs: string;
    toolIds: string[];
    requestedToolIds?: string[];
    roleIds?: string[];
    skillVersionIds?: string[];
    compiledInstructions?: string;
    responsibilities?: string[];
    expectedOutcomes?: string[];
    memoryPolicy: AgentVersion["memoryPolicy"];
    modelTier: AgentVersion["modelTier"];
    grantRequestedTools?: boolean;
    handle?: string;
  }): { agent: Agent; version: AgentVersion } {
    const agent: Agent = {
      id: id("agt"),
      orgId: input.orgId,
      name: input.name,
      handle: input.handle ?? uniqueHandle(this, input.orgId, handleFromName(input.name)),
      createdAt: nowIso(),
    };
    this.agents.set(agent.id, agent);
    const principal = this.ensureAgentPrincipal(input.orgId, agent.id, agent.name);
    const version = this.addAgentVersion(agent.id, input);
    if (input.grantRequestedTools !== false) {
      for (const toolId of version.requestedToolIds) {
        this.upsertAccessGrant({
          orgId: input.orgId,
          principalId: principal.id,
          toolId,
          kind: "can_use",
        });
      }
    }
    return { agent, version };
  }

  addAgentVersion(
    agentId: string,
    input: {
      identity: string;
      jobs: string;
      toolIds: string[];
      requestedToolIds?: string[];
      roleIds?: string[];
      skillVersionIds?: string[];
      compiledInstructions?: string;
      responsibilities?: string[];
      expectedOutcomes?: string[];
      memoryPolicy: AgentVersion["memoryPolicy"];
      modelTier: AgentVersion["modelTier"];
    },
  ): AgentVersion {
    const latest = this.latestVersion(agentId);
    const requestedToolIds = input.requestedToolIds ?? input.toolIds;
    const version: AgentVersion = {
      id: id("agv"),
      agentId,
      version: (latest?.version ?? 0) + 1,
      identity: input.identity,
      jobs: input.jobs,
      toolIds: requestedToolIds,
      requestedToolIds,
      roleIds: input.roleIds ?? [],
      skillVersionIds: input.skillVersionIds ?? [],
      compiledInstructions:
        input.compiledInstructions ?? `${input.identity}\n${input.jobs}`,
      responsibilities: input.responsibilities ?? [],
      expectedOutcomes: input.expectedOutcomes ?? [],
      memoryPolicy: input.memoryPolicy,
      modelTier: input.modelTier,
      createdAt: nowIso(),
    };
    this.agentVersions.set(version.id, version);
    return version;
  }

  ensureHumanPrincipal(orgId: string, userId: string, displayName: string): Principal {
    const existing = [...this.principals.values()].find(
      (row) => row.orgId === orgId && row.type === "human" && row.userId === userId,
    );
    if (existing) {
      existing.displayName = displayName;
      return existing;
    }
    const principal: Principal = {
      id: id("prn"),
      orgId,
      type: "human",
      userId,
      agentId: null,
      displayName,
    };
    this.principals.set(principal.id, principal);
    return principal;
  }

  ensureAgentPrincipal(orgId: string, agentId: string, displayName: string): Principal {
    const existing = [...this.principals.values()].find(
      (row) => row.orgId === orgId && row.type === "agent" && row.agentId === agentId,
    );
    if (existing) {
      existing.displayName = displayName;
      return existing;
    }
    const principal: Principal = {
      id: id("prn"),
      orgId,
      type: "agent",
      userId: null,
      agentId,
      displayName,
    };
    this.principals.set(principal.id, principal);
    return principal;
  }

  upsertAccessGrant(input: {
    orgId: string;
    principalId: string;
    toolId: string;
    kind: AccessGrant["kind"];
  }): AccessGrant {
    const existing = [...this.accessGrants.values()].find(
      (row) =>
        row.orgId === input.orgId &&
        row.principalId === input.principalId &&
        row.toolId === input.toolId &&
        row.kind === input.kind,
    );
    if (existing) {
      return existing;
    }
    const grant: AccessGrant = {
      id: id("acc"),
      orgId: input.orgId,
      principalId: input.principalId,
      toolId: input.toolId,
      kind: input.kind,
    };
    this.accessGrants.set(grant.id, grant);
    return grant;
  }

  policyOutcomeFor(orgId: string, principalId: string, toolId: string): PolicyOutcome | undefined {
    return [...this.policyRecords.values()].find(
      (row) =>
        row.orgId === orgId && row.principalId === principalId && row.toolId === toolId,
    )?.outcome;
  }

  upsertPolicyRecord(input: {
    orgId: string;
    principalId: string;
    toolId: string;
    outcome: PolicyOutcome;
  }): PolicyRecord {
    const existing = [...this.policyRecords.values()].find(
      (row) =>
        row.orgId === input.orgId &&
        row.principalId === input.principalId &&
        row.toolId === input.toolId,
    );
    if (existing) {
      existing.outcome = input.outcome;
      return existing;
    }
    const record: PolicyRecord = {
      id: id("pol"),
      orgId: input.orgId,
      principalId: input.principalId,
      toolId: input.toolId,
      outcome: input.outcome,
    };
    this.policyRecords.set(record.id, record);
    return record;
  }

  enabledCapability(orgId: string, toolId: string): Capability | undefined {
    return [...this.capabilities.values()].find(
      (row) => row.orgId === orgId && row.toolId === toolId && row.enabled,
    );
  }

  customToolById(orgId: string, toolId: string): CustomTool | undefined {
    return [...this.customTools.values()].find((row) => row.orgId === orgId && row.toolId === toolId);
  }

  connectorsFor(orgId: string): Connector[] {
    return [...this.connectors.values()].filter((row) => row.orgId === orgId);
  }

  draftsFor(orgId: string): IntegrationDraft[] {
    return [...this.integrationDrafts.values()]
      .filter((row) => row.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  sourcesForDraft(draftId: string): IntegrationSource[] {
    return [...this.integrationSources.values()]
      .filter((row) => row.draftId === draftId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  validationsForDraft(draftId: string): IntegrationValidation[] {
    return [...this.integrationValidations.values()]
      .filter((row) => row.draftId === draftId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  healthFor(orgId: string): ConnectorHealth[] {
    return [...this.connectorHealth.values()].filter((row) => row.orgId === orgId);
  }

  rememberWebhookDelivery(row: WebhookDelivery): boolean {
    const exists = [...this.webhookDeliveries.values()].some(
      (item) => item.connectorId === row.connectorId && item.nonce === row.nonce,
    );
    if (exists) {
      return false;
    }
    this.webhookDeliveries.set(row.id, row);
    return true;
  }

  latestSkillVersion(skillId: string): SkillVersion | undefined {
    return [...this.skillVersions.values()]
      .filter((row) => row.skillId === skillId)
      .sort((a, b) => b.version - a.version)[0];
  }

  findAgentByName(orgId: string, name: string): Agent | undefined {
    const needle = name.toLowerCase();
    return this.listAgents(orgId).find((agent) => agent.name.toLowerCase() === needle);
  }

  findAgentByHandle(orgId: string, handle: string): Agent | undefined {
    const needle = handle.toLowerCase();
    return this.listAgents(orgId).find((agent) => agent.handle === needle);
  }

  resolveAgent(orgId: string, mention: string): Agent | undefined {
    return this.findAgentByHandle(orgId, mention) ?? this.findAgentByName(orgId, mention);
  }

  seedDefaultJarvis(orgId: string): { agent: Agent; version: AgentVersion } {
    const existing = this.findAgentByName(orgId, "Jarvis");
    if (existing) {
      return { agent: existing, version: this.latestVersion(existing.id)! };
    }
    return this.createAgent({
      orgId,
      name: "Jarvis",
      handle: "jarvis",
      identity: "You are Jarvis, the org orchestrator for Envia desktop.",
      jobs: "Help the user remember facts, recall them, and operate desktop tools.",
      toolIds: [...DEFAULT_JARVIS_TOOLS],
      memoryPolicy: {
        allowScopes: ["personal", "agent", "organization", "conversation"],
      },
      modelTier: "sol",
    });
  }

  createThread(input: {
    orgId: string;
    actorId: string;
    agentId: string;
    title?: string;
  }): Thread {
    const thread: Thread = {
      id: id("thr"),
      orgId: input.orgId,
      actorId: input.actorId,
      agentId: input.agentId,
      title: input.title ?? null,
      createdAt: nowIso(),
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  addMessage(threadId: string, role: Message["role"], content: string): Message {
    const message: Message = {
      id: id("msg"),
      threadId,
      role,
      content,
      embedding: embedText(content),
      createdAt: nowIso(),
    };
    this.messages.push(message);
    this.refreshThreadSummary(threadId);
    return message;
  }

  messagesFor(threadId: string): Message[] {
    return this.messages
      .filter((row) => row.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  refreshThreadSummary(threadId: string): ThreadSummary | undefined {
    const rows = this.messagesFor(threadId);
    if (rows.length === 0) {
      return undefined;
    }
    const lastUser = [...rows].reverse().find((row) => row.role === "user");
    const summary: ThreadSummary = {
      threadId,
      summary: (lastUser?.content ?? rows.at(-1)?.content ?? "").slice(0, 240),
      throughMessageId: rows.at(-1)!.id,
      updatedAt: nowIso(),
    };
    this.threadSummaries.set(threadId, summary);
    return summary;
  }

  listThreads(orgId: string, actorId: string): Thread[] {
    return [...this.threads.values()].filter(
      (thread) => thread.orgId === orgId && thread.actorId === actorId,
    );
  }

  createRun(input: Omit<Run, "attempt" | "workerId" | "leaseExpiresAt" | "nextWakeAt" | "createdAt" | "status" | "taskId"> & {
    status?: RunStatus;
    taskId?: string | null;
  }): Run {
    const run: Run = {
      ...input,
      taskId: input.taskId ?? null,
      status: input.status ?? "queued",
      attempt: 0,
      workerId: null,
      leaseExpiresAt: null,
      nextWakeAt: null,
      createdAt: nowIso(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  claimRun(workerId: string, leaseMs: number): Run | undefined {
    const now = Date.now();
    for (const run of this.runs.values()) {
      const leaseExpired =
        run.status === "running" &&
        run.leaseExpiresAt !== null &&
        Date.parse(run.leaseExpiresAt) < now;
      const parkedReady =
        (run.status === "waiting_for_local_tool" ||
          run.status === "waiting_for_approval" ||
          run.status === "waiting_for_connect") &&
        run.nextWakeAt !== null &&
        Date.parse(run.nextWakeAt) <= now;
      if (run.status === "queued" || leaseExpired || parkedReady) {
        run.status = "running";
        run.attempt += 1;
        run.workerId = workerId;
        run.leaseExpiresAt = new Date(now + leaseMs).toISOString();
        run.nextWakeAt = null;
        return run;
      }
    }
    return undefined;
  }

  setRunStatus(
    runId: string,
    status: RunStatus,
    extra?: { nextWakeAt?: string | null; clearLease?: boolean },
  ): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.status = status;
    if (extra?.nextWakeAt !== undefined) {
      run.nextWakeAt = extra.nextWakeAt;
    }
    if (extra?.clearLease) {
      run.workerId = null;
      run.leaseExpiresAt = null;
    }
  }

  addStep(runId: string, type: string, payload: Record<string, unknown>): RunStep {
    const sequence =
      this.runSteps.filter((step) => step.runId === runId).length + 1;
    const step: RunStep = {
      id: id("stp"),
      runId,
      sequence,
      type,
      payload,
      createdAt: nowIso(),
    };
    this.runSteps.push(step);
    return step;
  }

  stepsFor(runId: string): RunStep[] {
    return this.runSteps
      .filter((step) => step.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  createInvocation(row: ToolInvocation): ToolInvocation {
    const next = {
      ...row,
      argumentsSealed: row.argumentsSealed ?? null,
      resultSealed: row.resultSealed ?? null,
    };
    this.invocations.set(next.id, next);
    return next;
  }

  getInvocation(invocationId: string): ToolInvocation | undefined {
    return this.invocations.get(invocationId);
  }

  sentInvocationsForRun(runId: string): ToolInvocation[] {
    return [...this.invocations.values()].filter(
      (row) => row.runId === runId && row.status === "sent",
    );
  }

  completeInvocation(
    invocationId: string,
    status: InvocationStatus,
    result: unknown,
  ): ToolInvocation | undefined {
    const row = this.invocations.get(invocationId);
    if (!row) {
      return undefined;
    }
    if (row.status === "succeeded" || row.status === "failed") {
      return row;
    }
    row.status = status;
    row.result = result;
    return row;
  }

  createApproval(row: Approval): Approval {
    this.approvals.set(row.id, row);
    return row;
  }

  getApproval(approvalId: string): Approval | undefined {
    return this.approvals.get(approvalId);
  }

  decideApproval(approvalId: string, decision: ApprovalDecision): Approval | undefined {
    const row = this.approvals.get(approvalId);
    if (!row) {
      return undefined;
    }
    if (row.decision !== "pending") {
      return row;
    }
    row.decision = decision;
    row.decidedAt = nowIso();
    return row;
  }

  pendingApprovalFor(invocationId: string): Approval | undefined {
    return [...this.approvals.values()].find(
      (row) => row.toolInvocationId === invocationId && row.decision === "pending",
    );
  }

  approvalFor(invocationId: string): Approval | undefined {
    return [...this.approvals.values()].find((row) => row.toolInvocationId === invocationId);
  }

  wakeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.nextWakeAt = nowIso();
    run.workerId = null;
    run.leaseExpiresAt = null;
  }

  revokeGrant(grantId: string): GrantProjection | undefined {
    const grant = this.grants.get(grantId);
    if (grant && !grant.revokedAt) {
      grant.revokedAt = nowIso();
    }
    return grant;
  }

  addMemory(row: Memory): Memory {
    this.memories.push(row);
    return row;
  }

  addActionOutcome(row: Omit<ActionOutcome, "id" | "createdAt"> & { id?: string }): ActionOutcome {
    const outcome: ActionOutcome = {
      id: row.id ?? id("act"),
      orgId: row.orgId,
      agentId: row.agentId,
      threadId: row.threadId,
      taskId: row.taskId,
      runId: row.runId,
      tool: row.tool,
      summary: row.summary,
      createdAt: nowIso(),
    };
    this.actionOutcomes.push(outcome);
    return outcome;
  }

  actionOutcomesFor(input: { orgId: string; agentId: string; threadId?: string; taskId?: string | null }): ActionOutcome[] {
    return this.actionOutcomes
      .filter((row) => {
        if (row.orgId !== input.orgId || row.agentId !== input.agentId) {
          return false;
        }
        if (input.taskId && row.taskId !== input.taskId) {
          return false;
        }
        if (input.threadId && row.threadId !== input.threadId) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recall(input: {
    orgId: string;
    actorId: string;
    agentId: string;
    threadId: string;
    allowScopes: MemoryScope[];
    query: string;
    embedding: number[];
  }): Memory[] {
    const scored = this.memories
      .filter((memory) => {
        if (memory.orgId !== input.orgId) {
          return false;
        }
        if (!input.allowScopes.includes(memory.scopeType)) {
          return false;
        }
        if (memory.expiresAt && Date.parse(memory.expiresAt) < Date.now()) {
          return false;
        }
        if (memory.scopeType === "personal" && memory.subjectUserId !== input.actorId) {
          return false;
        }
        if (memory.scopeType === "agent" && memory.scopeId !== input.agentId) {
          return false;
        }
        if (memory.scopeType === "conversation" && memory.scopeId !== input.threadId) {
          return false;
        }
        return true;
      })
      .map((memory) => ({
        memory,
        score:
          cosine(memory.embedding, input.embedding) *
            memory.importance *
            memory.confidence *
            recencyWeight(memory.createdAt) +
          (memory.source === "explicit" ? 0.15 : 0) +
          (memory.content.toLowerCase().includes(input.query.toLowerCase())
            ? 0.2
            : 0),
      }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((row) => row.memory);
  }

  appendEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): RunEvent {
    const sequence =
      this.runEvents.filter((event) => event.runId === runId).length + 1;
    const event: RunEvent = {
      id: id("evt"),
      runId,
      sequence,
      eventType,
      payload,
      createdAt: nowIso(),
    };
    this.runEvents.push(event);
    return event;
  }

  eventsAfter(runId: string, afterSequence: number): RunEvent[] {
    return this.runEvents
      .filter((event) => event.runId === runId && event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  audit(row: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const event: AuditEvent = { ...row, id: id("aud"), createdAt: nowIso() };
    this.auditEvents.push(event);
    return event;
  }

  trace(row: Omit<TraceEvent, "id" | "createdAt">): TraceEvent {
    const event: TraceEvent = { ...row, id: id("trc"), createdAt: nowIso() };
    this.traceEvents.push(event);
    return event;
  }

  upsertGrant(row: GrantProjection): GrantProjection {
    this.grants.set(row.grantId, row);
    return row;
  }

  activeGrant(input: {
    orgId: string;
    deviceId: string;
    capability: string;
  }): GrantProjection | undefined {
    const now = Date.now();
    return [...this.grants.values()].find((grant) => {
      if (grant.orgId !== input.orgId || grant.deviceId !== input.deviceId) {
        return false;
      }
      if (grant.capability !== input.capability) {
        return false;
      }
      if (grant.revokedAt) {
        return false;
      }
      if (grant.expiresAt && Date.parse(grant.expiresAt) < now) {
        return false;
      }
      return true;
    });
  }

  rememberNonce(nonce: string): boolean {
    if (this.usedNonces.has(nonce)) {
      return false;
    }
    this.usedNonces.add(nonce);
    return true;
  }
}

export const store = new JarvisStore();
