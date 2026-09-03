export type PolicyOutcome = "ALLOW" | "ALLOW_WITH_APPROVAL" | "DENY";
export type ToolSide = "cloud" | "client" | "native";
export type ToolRisk =
  | "low"
  | "sensitive_read"
  | "external_write"
  | "destructive"
  | "privileged";
export type ModelTier = "sol" | "terra" | "luna";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_local_tool"
  | "waiting_for_approval"
  | "waiting_for_connect"
  | "completed"
  | "failed";
export type InvocationStatus = "pending" | "sent" | "succeeded" | "failed";
export type ApprovalDecision = "pending" | "approved" | "rejected";
export type MemoryScope = "personal" | "agent" | "organization" | "conversation";
export type MemorySource = "explicit" | "inferred";

export type MemoryPolicy = {
  allowScopes: MemoryScope[];
};

export type Organization = {
  companyId: string;
  name: string;
  graphRevision: number;
  createdAt: string;
};
export type Membership = { companyId: string; userId: string; createdAt: string };
export type PrincipalType = "human" | "agent";
export type UnitType = "company" | "department" | "team" | "project";
export type ProposalStatus = "draft" | "instantiated";
export type WorkflowStatus = "draft";
export type BulkItemStatus =
  | "created"
  | "ok"
  | "conflict"
  | "not_found"
  | "error";

export type Principal = {
  id: string;
  orgId: string;
  type: PrincipalType;
  userId: string | null;
  agentId: string | null;
  displayName: string;
};

export type OrganizationalUnit = {
  id: string;
  orgId: string;
  type: UnitType;
  name: string;
  parentUnitId: string | null;
};

export type ProjectDetails = {
  unitId: string;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  objectiveId: string | null;
};

export type Role = {
  id: string;
  orgId: string;
  name: string;
  requiredToolIds: string[];
};

export type Skill = {
  id: string;
  orgId: string;
  name: string;
};

export type SkillVersion = {
  id: string;
  skillId: string;
  version: number;
  instructions: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiredTools: string[];
  requiredKnowledge: string[];
  evaluationPolicy: Record<string, unknown>;
};

export type UnitMembership = {
  id: string;
  orgId: string;
  principalId: string;
  unitId: string;
};

export type AgentRole = {
  id: string;
  orgId: string;
  agentId: string;
  roleId: string;
  priority: number;
};

export type AgentSkill = {
  id: string;
  orgId: string;
  agentId: string;
  skillId: string;
  skillVersionId: string | null;
};

export type RoleSkill = {
  id: string;
  orgId: string;
  roleId: string;
  skillId: string;
};

export type RoleResponsibility = {
  id: string;
  orgId: string;
  roleId: string;
  text: string;
};

export type PrincipalRelationship = {
  id: string;
  orgId: string;
  kind: string;
  fromPrincipalId: string;
  toPrincipalId: string;
};

export type ProjectMembership = {
  id: string;
  orgId: string;
  principalId: string;
  unitId: string;
};

export type ObjectiveStatus = "open" | "done";
export type TaskStatus =
  | "planned"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskEventType =
  | "created"
  | "assigned"
  | "unassigned"
  | "dispatched"
  | "started"
  | "blocked"
  | "retried"
  | "completed"
  | "cancelled"
  | "priority_changed";
export type ProvenanceReason =
  | "identity"
  | "ranked"
  | "recent"
  | "retrieved"
  | "summary"
  | "granted"
  | "assigned"
  | "recorded";

export type Objective = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  status: ObjectiveStatus;
  projectUnitId: string | null;
};

export type ObjectiveOwner = {
  id: string;
  orgId: string;
  principalId: string;
  objectiveId: string;
};

export type Task = {
  id: string;
  orgId: string;
  objectiveId: string | null;
  name: string;
  description: string;
  priority: TaskPriority;
  assigneePrincipalId: string | null;
  status: TaskStatus;
  createdByPrincipalId: string | null;
  dueAt: string | null;
  projectUnitId: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskEvent = {
  id: string;
  taskId: string;
  type: TaskEventType;
  actorPrincipalId: string | null;
  runId: string | null;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ContextProvenance = {
  layer: string;
  kind: string;
  id: string;
  reason: ProvenanceReason;
};

export type LayerUsage = {
  used: number;
  budget: number;
};

export type ContextCompilation = {
  id: string;
  runId: string;
  runStepId: string;
  compilerVersion: string;
  agentVersionId: string;
  usage: Record<string, LayerUsage>;
  provenance: ContextProvenance[];
  presentedTools: string[];
  requestableTools: string[];
  promptHash: string;
  contextHash: string;
  createdAt: string;
};

export type Workflow = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
  status: WorkflowStatus;
};

export type AccessGrant = {
  id: string;
  orgId: string;
  principalId: string;
  toolId: string;
  kind: "can_use" | "can_read";
};

export type PolicyRecord = {
  id: string;
  orgId: string;
  principalId: string;
  toolId: string;
  outcome: PolicyOutcome;
};

export type GraphNodeMeta = {
  unitType?: OrganizationalUnit["type"];
  parentUnitId?: string | null;
};

export type GraphNode = {
  id: string;
  kind: string;
  label: string;
  refId: string;
  meta?: GraphNodeMeta;
};

export type GraphEdge = {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  sourceTable: string;
};

export type CapabilityGap = {
  agentId: string;
  agentName: string;
  toolId: string;
  requiredBy: string;
};

export type StudioProposal = {
  id: string;
  orgId: string;
  createdBy: string;
  brief: string;
  templateId: string | null;
  baseGraphRevision: number;
  revision: number;
  contentHash: string;
  status: ProposalStatus;
  nodes: GraphNode[];
  edges: GraphEdge[];
  instantiatedAt: string | null;
  createdAt: string;
};

export type Device = {
  id: string;
  userId: string;
  orgId: string;
  publicKey: string;
  name: string;
  accountsDeviceId: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type JarvisSession = {
  id: string;
  userId: string;
  orgId: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type Agent = {
  id: string;
  orgId: string;
  name: string;
  handle: string;
  createdAt: string;
};

export type AgentVersion = {
  id: string;
  agentId: string;
  version: number;
  identity: string;
  jobs: string;
  toolIds: string[];
  requestedToolIds: string[];
  roleIds: string[];
  skillVersionIds: string[];
  compiledInstructions: string;
  responsibilities: string[];
  expectedOutcomes: string[];
  memoryPolicy: MemoryPolicy;
  modelTier: ModelTier;
  createdAt: string;
};

export type Thread = {
  id: string;
  orgId: string;
  actorId: string;
  agentId: string;
  title: string | null;
  createdAt: string;
};

export type Message = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  embedding: number[];
  createdAt: string;
};

export type ThreadSummary = {
  threadId: string;
  summary: string;
  throughMessageId: string;
  updatedAt: string;
};

export type ActionOutcome = {
  id: string;
  orgId: string;
  agentId: string;
  threadId: string;
  taskId: string | null;
  runId: string;
  tool: string;
  summary: string;
  createdAt: string;
};

export type Run = {
  id: string;
  orgId: string;
  actorId: string;
  threadId: string;
  agentId: string;
  agentVersion: string;
  taskId: string | null;
  sessionId: string;
  deviceId: string;
  prompt: string;
  status: RunStatus;
  attempt: number;
  workerId: string | null;
  leaseExpiresAt: string | null;
  nextWakeAt: string | null;
  createdAt: string;
};

export type RunStep = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CredentialKind = "bearer" | "header_map" | "basic" | "mcp" | "webhook_secret";
export type ConnectorKind = "mcp" | "openapi" | "webhook";
export type ConnectorPurpose =
  | "shop"
  | "outbound"
  | "commerce"
  | "email"
  | "messaging"
  | "calendar"
  | "custom";

export type ConnectSession = {
  id: string;
  orgId: string;
  runId: string | null;
  agentId: string;
  createdBy: string;
  providerId: string | null;
  purpose: string | null;
  status: "pending" | "completed" | "failed";
  oauthState: string | null;
  toolIds: string[];
  fields: Record<string, string>;
  createdAt: string;
};

export type Credential = {
  id: string;
  orgId: string;
  label: string;
  kind: CredentialKind;
  sealed: string;
  keyVersion: number;
  createdBy: string;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
};

export type ConnectorPublicConfig = {
  origin: string;
  purpose?: ConnectorPurpose;
  operationIds?: string[];
};

export type Connector = {
  id: string;
  orgId: string;
  kind: ConnectorKind;
  name: string;
  status: "active" | "disabled";
  revision: number;
  credentialId: string | null;
  publicConfig: ConnectorPublicConfig;
  specHash: string | null;
  authSealed: string | null;
  createdAt: string;
};

export type CapabilityBinding = {
  method?: string;
  path?: string;
  mcpName?: string;
};

export type Capability = {
  id: string;
  orgId: string;
  connectorId: string;
  toolId: string;
  version: number;
  side: ToolSide;
  risk: ToolRisk;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  binding: CapabilityBinding;
  enabled: boolean;
};

/**
 * Immutable snapshot of a connector at one revision. Created when an attach
 * changes the spec; the live `connectors` row stays the current pointer while
 * runs already in flight keep referencing the version they started against.
 */
export type ConnectorVersion = {
  id: string;
  connectorId: string;
  orgId: string;
  revision: number;
  specHash: string | null;
  publicConfig: ConnectorPublicConfig;
  createdAt: string;
};

/** Immutable snapshot of a single capability version, linked to its connector version. */
export type CapabilityVersion = {
  id: string;
  capabilityId: string;
  connectorVersionId: string;
  orgId: string;
  toolId: string;
  version: number;
  side: ToolSide;
  risk: ToolRisk;
  binding: CapabilityBinding;
  createdAt: string;
};

export type CustomToolStep = {
  toolId: string;
  version: number;
  map?: Record<string, string>;
  filter?: Record<string, unknown>;
};

export type CustomToolDefinition = {
  steps: CustomToolStep[];
  groupBy?: string[];
  cap?: number;
  cutoffDays?: number;
};

export type CustomTool = {
  id: string;
  orgId: string;
  toolId: string;
  definition: CustomToolDefinition;
  risk: ToolRisk;
  createdAt: string;
};

export type WebhookDelivery = {
  id: string;
  connectorId: string;
  nonce: string;
  timestamp: string;
  bodySealed: string;
  createdAt: string;
};

/**
 * Lifecycle of an integration draft as the AI Integration Engineer (Phase 3)
 * discovers, validates, and registers a connector. The `*_FAILED` / DISABLED /
 * REVOKED states are surfaced verbatim to the user; every failure can retry
 * back into the pipeline via {@link integration-lifecycle}.
 */
export type IntegrationDraftStatus =
  | "DRAFT"
  | "DISCOVERING"
  | "DOCS_REQUIRED"
  | "AUTH_REQUIRED"
  | "VALIDATING"
  | "REVIEW_REQUIRED"
  | "READY"
  | "INVALID_SPEC"
  | "AUTH_FAILED"
  | "CONNECTION_FAILED"
  | "VALIDATION_FAILED"
  | "DISABLED"
  | "REVOKED";

export type IntegrationSourceType =
  | "openapi"
  | "mcp"
  | "documentation_url"
  | "uploaded_documentation"
  | "postman"
  | "manual"
  | "curl";

export type IntegrationValidationLevel =
  | "schema"
  | "connection"
  | "auth"
  | "safe_read"
  | "write_registered";

export type IntegrationValidationStatus = "pending" | "passed" | "failed" | "skipped";

/** An external API operation discovered from a source, before it becomes a capability. */
export type DiscoveredOperation = {
  externalId: string;
  method: string;
  path: string;
  summary?: string;
  capabilityId?: string;
  confidence?: number;
  risk?: ToolRisk;
};

/** A canonical capability the engineer proposes, mapped to one external operation. */
export type ProposedCapability = {
  capabilityId: string;
  toolId: string;
  externalId: string;
  method: string;
  path: string;
  risk: ToolRisk;
  confidence: number;
};

export type IntegrationDraft = {
  id: string;
  orgId: string;
  name: string;
  sourceType: IntegrationSourceType | null;
  status: IntegrationDraftStatus;
  specHash: string | null;
  baseUrl: string | null;
  discoveredAuth: Record<string, unknown> | null;
  discoveredOperations: DiscoveredOperation[];
  proposedCapabilities: ProposedCapability[];
  validationState: string | null;
  questions: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationSource = {
  id: string;
  draftId: string;
  type: IntegrationSourceType;
  ref: string | null;
  content: string | null;
  sha: string | null;
  createdAt: string;
};

export type IntegrationValidation = {
  id: string;
  draftId: string;
  level: IntegrationValidationLevel;
  status: IntegrationValidationStatus;
  detail: Record<string, unknown>;
  createdAt: string;
};

/**
 * Operational health of a live connector. Updated by the validator and by
 * runtime execution failures. The resolver reads it so an AUTH_EXPIRED
 * connector blocks tasks with a Reconnect path instead of letting the model
 * improvise around a dead credential.
 */
export type ConnectorHealthState =
  | "READY"
  | "DEGRADED"
  | "AUTH_EXPIRED"
  | "UNREACHABLE"
  | "SCHEMA_CHANGED"
  | "DISABLED"
  | "REVOKED";

export type ConnectorHealth = {
  connectorId: string;
  orgId: string;
  state: ConnectorHealthState;
  detail: string | null;
  checkedAt: string;
};

/**
 * One credential input a connection needs. Structurally identical to the
 * catalog `AuthField` (providers.ts) so the same dynamic form renders both a
 * catalog method and a learned/AI recipe. `secret: true` masks the input.
 */
export type RecipeField = {
  key: string;
  label: string;
  help: string;
  href?: string;
  secret?: boolean;
};

export type RecipeAuthKind = "oauth" | "bearer" | "header_map" | "basic" | "mcp";

export type RecipeOAuth = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
};

export type RecipeAuth = {
  kind: RecipeAuthKind;
  oauth?: RecipeOAuth;
};

/** A capability binding a recipe proposes, used to prefill an engineer draft. */
export type RecipeOperation = {
  toolId: string;
  method: string;
  path: string;
  risk: ToolRisk;
};

export type RecipeSource = "catalog" | "learned" | "ai";

/**
 * The proven "how to connect" for a product. Platform-wide and shared across
 * orgs — it carries only the connection *shape* (auth method, base URL,
 * credential field schema, docs, steps, proposed operations), NEVER any secret
 * value. Catalog recipes come from a {@link ProviderSpec}; learned recipes are
 * upserted after a connection is proven live; AI recipes come from doc review.
 */
export type IntegrationRecipe = {
  slug: string;
  displayName: string;
  aliases: string[];
  purpose: string;
  baseUrl: string | null;
  recommendedAuth: RecipeAuth;
  requiredFields: RecipeField[];
  fallbackAuth: { auth: RecipeAuth; fields: RecipeField[] } | null;
  steps: string[];
  docs: Array<{ title: string; url: string }>;
  operations: RecipeOperation[];
  /** The credential kind used to seal + attach once fields are captured. */
  credentialKind: CredentialKind;
  source: RecipeSource;
  confidence: number;
  successCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
};

export type ToolInvocation = {
  id: string;
  runId: string;
  runStepId: string;
  sessionId: string;
  deviceId: string;
  requestId: string;
  side: ToolSide;
  tool: string;
  arguments: Record<string, unknown>;
  argsHash: string;
  status: InvocationStatus;
  result: unknown;
  argumentsSealed?: string | null;
  resultSealed?: string | null;
  grantId: string | null;
  connectorVersionId?: string | null;
  capabilityVersionId?: string | null;
  nonce: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type Approval = {
  id: string;
  toolInvocationId: string;
  tool: string;
  argsHash: string;
  agentVersion: string;
  runId: string;
  expiresAt: string;
  decidedAt: string | null;
  decision: ApprovalDecision;
};

export type Memory = {
  id: string;
  orgId: string;
  scopeType: MemoryScope;
  scopeId: string | null;
  subjectUserId: string | null;
  createdByAgentId: string | null;
  source: MemorySource;
  content: string;
  importance: number;
  confidence: number;
  sensitivity: string;
  embedding: number[];
  createdAt: string;
  lastConfirmedAt: string | null;
  expiresAt: string | null;
};

export type RunEvent = {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  orgId: string;
  actorId: string;
  agentId: string | null;
  agentVersion: string | null;
  action: string;
  policyOutcome: PolicyOutcome | null;
  approvalId: string | null;
  deviceId: string | null;
  executionResult: string;
  createdAt: string;
};

export type TraceEvent = {
  id: string;
  runId: string;
  runStepId: string | null;
  modelTier: ModelTier | null;
  latencyMs: number | null;
  tokenCount: number | null;
  memoryRetrievalIds: string[];
  toolPlanning: unknown;
  errorDetails: string | null;
  createdAt: string;
};

export type GrantProjection = {
  grantId: string;
  orgId: string;
  deviceId: string;
  capability: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AuthContext = {
  userId: string;
  orgId: string;
  deviceId: string;
  sessionId: string;
};
