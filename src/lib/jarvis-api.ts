import { invoke } from "@tauri-apps/api/core";
import { getServiceById } from "@/config/services";
import { getTendencysBaseUrl } from "@/lib/tendencys-auth";
import { JARVIS_API_BASE, jarvisFetch } from "./jarvis-http";
import { resolveJarvisOpenService } from "./jarvis-open-service";
import { clearCachedJarvisSession, writeCachedJarvisSession } from "./jarvis-session-cache";

export { JARVIS_API_BASE };

export type JarvisSession = {
  token: string;
  expiresAt: string;
  sessionId: string;
  userId: string;
  orgId: string;
  deviceId: string;
  serverPublicKey: string;
};

export type JarvisIdentity = {
  deviceId: string;
  publicKey: string;
  attestation: string;
};

export type JarvisEnvelope = {
  toolInvocationId: string;
  requestId: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  tool: string;
  toolVersion: number;
  grantId: string | null;
  arguments: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  serverSignature: string;
};

export type JarvisEvent = {
  id: string;
  event: string;
  data: Record<string, unknown>;
};

type Envelope<T> = { success: true; data: T } | { success: false; error: { message: string } };

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Envelope<T>;
  if (!response.ok || !body.success) {
    const message = !body.success ? body.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body.data;
}

export async function jarvisHealth(): Promise<{ serverPublicKey: string }> {
  return parse(await jarvisFetch(`${JARVIS_API_BASE}/api/v1/health`));
}

export async function createJarvisSession(atid: string): Promise<JarvisSession> {
  const identity = await invoke<JarvisIdentity>("jarvis_device_identity");
  const session = await parse<JarvisSession>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atid,
        deviceId: identity.deviceId,
        devicePublicKey: identity.publicKey,
        attestation: identity.attestation,
        deviceName: "Envia.com desktop",
        accountsBaseUrl: getTendencysBaseUrl(),
      }),
    }),
  );
  writeCachedJarvisSession(localStorage, session);
  return session;
}

export async function revokeJarvisSession(token: string): Promise<void> {
  await parse(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/auth/session/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  clearCachedJarvisSession(localStorage);
}

export type JarvisAgentActivityStatus =
  | "idle"
  | "starting"
  | "working"
  | "waiting_for_local_tool"
  | "waiting_for_approval"
  | "waiting_for_connect";

export type JarvisAgentActivity = {
  status: JarvisAgentActivityStatus;
  title: string | null;
};

export type JarvisAgent = {
  id: string;
  name: string;
  handle: string;
  latestVersion?: { modelTier?: string; jobs?: string };
  activity?: JarvisAgentActivity;
};

export async function listJarvisAgents(token: string) {
  return parse<{ items: JarvisAgent[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function createJarvisAgent(token: string, name: string) {
  return parse<{ agent: JarvisAgent }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        identity: `You are ${name}.`,
        jobs: `Serve the ${name} function.`,
      }),
    }),
  );
}

export type JarvisGraphNode = {
  id: string;
  kind: string;
  label: string;
  refId: string;
  meta?: { unitType?: string; parentUnitId?: string | null };
};

export type JarvisGraphEdge = {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  sourceTable: string;
};

export type JarvisCapabilityGap = {
  agentId: string;
  agentName: string;
  toolId: string;
  requiredBy: string;
};

export type JarvisConnectorHealthState =
  | "READY"
  | "DEGRADED"
  | "AUTH_EXPIRED"
  | "UNREACHABLE"
  | "SCHEMA_CHANGED"
  | "DISABLED"
  | "REVOKED";

export type JarvisStudioConnector = {
  id: string;
  name: string;
  kind: string;
  status: string;
  revision: number;
  purpose: string | null;
  origin: string;
  capabilityCount?: number;
  health?: JarvisConnectorHealthState;
  healthDetail?: string | null;
};

export type JarvisStudioCustomTool = {
  id: string;
  toolId: string;
  risk: string;
  steps: number;
};

export type JarvisStudioSnapshot = {
  org: { companyId: string; name: string; graphRevision: number };
  graphRevision: number;
  nodes: JarvisGraphNode[];
  edges: JarvisGraphEdge[];
  gaps: JarvisCapabilityGap[];
  connectors?: JarvisStudioConnector[];
  customTools?: JarvisStudioCustomTool[];
};

export type JarvisStudioProposal = {
  id: string;
  brief: string;
  templateId: string | null;
  revision: number;
  contentHash: string;
  status: string;
  nodes: JarvisGraphNode[];
  edges: JarvisGraphEdge[];
};

export async function getJarvisStudio(token: string) {
  return parse<JarvisStudioSnapshot>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function listJarvisStudioTemplates(token: string) {
  return parse<{ items: Array<{ id: string }> }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/templates`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function createJarvisStudioProposal(
  token: string,
  brief: string,
  templateId?: string,
) {
  return parse<{ proposal: JarvisStudioProposal }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/proposals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ brief, templateId }),
    }),
  );
}

export async function patchJarvisStudioProposal(
  token: string,
  proposalId: string,
  patch: { nodes?: JarvisGraphNode[]; edges?: JarvisGraphEdge[] },
) {
  return parse<{ proposal: JarvisStudioProposal }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/proposals/${proposalId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    }),
  );
}

export async function createJarvisStudioSkills(token: string, items: Array<{ name: string }>) {
  return parse<{
    results: Array<{ id: string; versionId: string; status: string }>;
    graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] };
  }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/skills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }),
  );
}

export async function createJarvisStudioUnits(
  token: string,
  items: Array<{ name: string; type?: "company" | "department" | "team" | "project"; parentUnitId?: string | null }>,
) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/units`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }),
  );
}

export async function patchJarvisStudioUnit(
  token: string,
  unitId: string,
  patch: { name?: string; parentUnitId?: string | null },
) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/units/${unitId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteJarvisStudioUnit(token: string, unitId: string) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/units/${unitId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function patchJarvisStudioPrincipal(token: string, principalId: string, displayName: string) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/principals/${principalId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName }),
    }),
  );
}

export async function writeJarvisStudioRelationships(
  token: string,
  items: Array<{ kind: string; fromId: string; toId: string }>,
) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/relationships`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }),
  );
}

export async function replaceJarvisReportsTo(token: string, fromId: string, toId: string) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/relationships/replace`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "reports_to", fromId, toId }),
    }),
  );
}

export async function deleteJarvisStudioRelationship(token: string, edgeId: string) {
  return parse<{ graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] } }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/relationships/${edgeId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export type JarvisCommunication = {
  id: string;
  createdAt: string;
  kind: "a_a" | "h_a" | "a_h";
  from: { id: string | null; type: string; name: string; handle: string | null };
  to: { id: string | null; type: string; name: string; handle: string | null };
  content: string;
  source: string;
};

export async function listJarvisCommunications(token: string) {
  return parse<{ items: JarvisCommunication[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/communications`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function instantiateJarvisStudioProposal(token: string, proposalId: string) {
  return parse<{
    proposal: JarvisStudioProposal;
    idempotent: boolean;
    graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] };
    gaps: JarvisCapabilityGap[];
  }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/proposals/${proposalId}/instantiate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export type JarvisMemory = {
  id: string;
  content: string;
  scopeType: string;
  source?: string;
  createdAt: string;
};

export type JarvisTaskPriority = "low" | "normal" | "high" | "urgent";
export type JarvisTaskStatus =
  | "planned"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";

export type JarvisTask = {
  id: string;
  name: string;
  description: string;
  priority: JarvisTaskPriority;
  status: JarvisTaskStatus;
  objectiveId: string | null;
  assigneePrincipalId: string | null;
  resultSummary: string | null;
};

export type JarvisInboxItem = {
  task: JarvisTask;
  assignee: { id: string; type: string; displayName: string; handle: string | null } | null;
  activeRun: { id: string; status: string } | null;
  lastRun: { id: string; status: string } | null;
};

export type JarvisObjective = {
  id: string;
  name: string;
  status: string;
};

export type JarvisPrincipal = {
  id: string;
  type: string;
  displayName: string;
  agentId: string | null;
  handle: string | null;
};

export type JarvisTaskEvent = {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
};

export async function listJarvisInbox(token: string, agentId?: string) {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  return parse<{ items: JarvisInboxItem[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/inbox${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function listJarvisObjectives(token: string) {
  return parse<{ items: JarvisObjective[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/objectives`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function listJarvisPrincipals(token: string) {
  return parse<{ items: JarvisPrincipal[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/principals`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function attachJarvisConnectors(
  token: string,
  items: Array<{
    kind: "mcp" | "openapi" | "webhook";
    name: string;
    purpose?: "shop" | "outbound" | "commerce" | "email" | "messaging" | "calendar" | "custom";
    origin: string;
    credential: { label: string; kind: string; secret: string };
    operations?: Array<{
      toolId: string;
      risk: string;
      binding: { method?: string; path?: string; mcpName?: string };
    }>;
  }>,
) {
  return parse<{ results: Array<{ connectorId: string; status: string; toolIds: string[] }> }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/connectors`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }),
  );
}

export async function saveJarvisCustomTools(
  token: string,
  items: Array<{
    toolId: string;
    definition: {
      steps: Array<{ toolId: string; version: number; map?: Record<string, string>; filter?: Record<string, unknown> }>;
      groupBy?: string[];
      cap?: number;
    };
  }>,
) {
  return parse<{ results: Array<{ toolId: string; status: string; risk: string }> }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/studio/custom-tools`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }),
  );
}

export async function patchJarvisTask(
  token: string,
  taskId: string,
  input: { assigneePrincipalId?: string | null },
) {
  return parse<{ task: JarvisTask; runId: string | null; created: boolean }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
}

export async function createJarvisTask(
  token: string,
  input: {
    name: string;
    objectiveId?: string | null;
    assigneePrincipalId?: string | null;
    priority?: JarvisTaskPriority;
  },
) {
  return parse<{ task: JarvisTask; runId: string | null; created: boolean }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
}

export async function startJarvisTask(token: string, taskId: string) {
  return parse<{ runId: string; threadId: string; created: boolean }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/tasks/${taskId}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function retryJarvisTask(token: string, taskId: string) {
  return parse<{ runId: string; threadId: string; created: boolean }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/tasks/${taskId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function listJarvisTaskEvents(token: string, taskId: string) {
  return parse<{ items: JarvisTaskEvent[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/tasks/${taskId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function listJarvisMemories(token: string) {
  return parse<{ items: JarvisMemory[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/memories`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export type JarvisThread = {
  id: string;
  orgId: string;
  actorId: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }>;
};

export async function listJarvisThreads(token: string) {
  return parse<{ items: JarvisThread[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function createJarvisRun(
  token: string,
  prompt: string,
  options?: { threadId?: string; agentId?: string },
) {
  return parse<{ runId: string; threadId: string; status: string }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        threadId: options?.threadId,
        agentId: options?.agentId,
      }),
    }),
  );
}

export type JarvisIntegrationCatalogItem = {
  id: string;
  purposes: string[];
  authMethods: Array<{
    kind: string;
    fields: Array<{ key: string; label: string; help?: string; href?: string; secret?: boolean }>;
  }>;
};

export type JarvisIntegrations = {
  connectors: JarvisStudioConnector[];
  customTools: JarvisStudioCustomTool[];
  catalog: JarvisIntegrationCatalogItem[];
};

export type JarvisConnectRequired = {
  status: "connect_required" | "connected";
  connectId?: string;
  purpose?: string;
  provider: string | null;
  ask?: string;
  candidates?: Array<{
    id: string;
    fields?: Array<{ key: string; label: string; help?: string; href?: string; secret?: boolean }>;
  }>;
  authMethods?: Array<{
    kind: string;
    fields: Array<{ key: string; label: string; help?: string; href?: string; secret?: boolean }>;
  }>;
  fields?: Array<{ key: string; label: string; help?: string; href?: string; secret?: boolean }>;
  toolIds?: string[];
};

export async function listJarvisIntegrations(token: string) {
  return parse<JarvisIntegrations>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function patchJarvisIntegration(
  token: string,
  connectorId: string,
  input: { name?: string; origin?: string; secret?: string },
) {
  return parse<{ connector: JarvisStudioConnector }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/${connectorId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteJarvisIntegration(token: string, connectorId: string) {
  return parse<{ connectorId: string; status: string }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/${connectorId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function startJarvisConnect(
  token: string,
  input: { product?: string; purpose?: string },
) {
  return parse<JarvisConnectRequired>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
}

export async function completeJarvisConnect(
  token: string,
  connectId: string,
  fields: Record<string, string>,
  providerId?: string,
) {
  return parse<{ status: string; provider?: string; toolIds?: string[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectId, fields, providerId }),
    }),
  );
}

export async function startJarvisOauth(
  token: string,
  connectId: string,
  fields: Record<string, string>,
  providerId?: string,
) {
  return parse<{ url: string; state: string }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/oauth/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectId, fields, providerId }),
    }),
  );
}

export async function decideJarvisApproval(
  token: string,
  approvalId: string,
  decision: "approved" | "rejected",
) {
  return parse(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision }),
    }),
  );
}

export async function subscribeJarvisEvents(
  token: string,
  runId: string,
  onEvent: (event: JarvisEvent) => void | Promise<void>,
  lastEventId = "0",
): Promise<void> {
  const response = await jarvisFetch(`${JARVIS_API_BASE}/api/v1/runs/${runId}/events`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Last-Event-ID": lastEventId,
    },
  });
  if (response.status === 401) {
    throw new Error("SSE 401");
  }
  if (!response.ok || !response.body) {
    throw new Error(`SSE ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let current: Partial<JarvisEvent> & { raw?: string } = {};
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("id:")) {
        current.id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        current.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        current.raw = line.slice(5).trim();
      } else if (line.trim() === "" && current.event && current.raw) {
        await onEvent({
          id: current.id ?? "0",
          event: current.event,
          data: JSON.parse(current.raw) as Record<string, unknown>,
        });
        current = {};
      }
    }
  }
}

export async function subscribeJarvisRun(
  token: string,
  runId: string,
  onEvent: (event: JarvisEvent) => void | Promise<void>,
  options?: {
    getToken?: () => string;
    onUnauthorized?: () => Promise<string>;
  },
): Promise<void> {
  let lastEventId = "0";
  let terminal = false;
  let currentToken = token;
  while (!terminal) {
    try {
      await subscribeJarvisEvents(
        options?.getToken?.() ?? currentToken,
        runId,
        async (event) => {
          if (event.id) {
            lastEventId = event.id;
          }
          if (event.event === "run_state") {
            const status = String(event.data.status ?? "");
            if (status === "completed" || status === "failed") {
              terminal = true;
            }
          }
          await onEvent(event);
        },
        lastEventId,
      );
      if (terminal) {
        return;
      }
    } catch (err) {
      if (String(err).includes("SSE 401") && options?.onUnauthorized) {
        currentToken = await options.onUnauthorized();
        continue;
      }
      throw err;
    }
  }
}

export type JarvisDraftStatus =
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

export type JarvisProposedCapability = {
  capabilityId: string;
  toolId: string;
  externalId: string;
  method: string;
  path: string;
  risk: string;
  confidence: number;
};

export type JarvisIntegrationDraft = {
  id: string;
  orgId: string;
  name: string;
  sourceType: string | null;
  status: JarvisDraftStatus;
  specHash: string | null;
  baseUrl: string | null;
  discoveredAuth: Record<string, unknown> | null;
  discoveredOperations: Array<{
    externalId: string;
    method: string;
    path: string;
    summary?: string;
    capabilityId?: string;
    confidence?: number;
    risk?: string;
  }>;
  proposedCapabilities: JarvisProposedCapability[];
  validationState: string | null;
  questions: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type JarvisIntegrationSource = {
  id: string;
  draftId: string;
  type: string;
  ref: string | null;
  sha: string | null;
  createdAt: string;
};

export type JarvisIntegrationValidation = {
  id: string;
  draftId: string;
  level: string;
  status: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type JarvisEngineerSourceType =
  | "openapi"
  | "mcp"
  | "documentation_url"
  | "uploaded_documentation"
  | "postman"
  | "manual"
  | "curl";

export async function listJarvisDrafts(token: string) {
  return parse<{ drafts: JarvisIntegrationDraft[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function createJarvisDraft(token: string, name: string) {
  return parse<{ draft: JarvisIntegrationDraft }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

export async function getJarvisDraft(token: string, draftId: string) {
  return parse<{
    draft: JarvisIntegrationDraft;
    sources: JarvisIntegrationSource[];
    validations: JarvisIntegrationValidation[];
  }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function addJarvisDraftSource(
  token: string,
  draftId: string,
  input: { type: JarvisEngineerSourceType; ref?: string; content?: string },
) {
  return parse<{ draft: JarvisIntegrationDraft }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}/source`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function answerJarvisDraft(
  token: string,
  draftId: string,
  input: { baseUrl?: string; authKind?: string },
) {
  return parse<{ draft: JarvisIntegrationDraft }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function proposeJarvisDraft(token: string, draftId: string) {
  return parse<{ draft: JarvisIntegrationDraft }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}/propose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function validateJarvisDraft(
  token: string,
  draftId: string,
  credential?: { secret?: string; fields?: Record<string, string> },
) {
  return parse<{ draft: JarvisIntegrationDraft; validations: JarvisIntegrationValidation[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}/validate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(credential ?? {}),
    }),
  );
}

export async function approveJarvisDraft(
  token: string,
  draftId: string,
  credential: { secret?: string; fields?: Record<string, string> },
) {
  return parse<{ draft: JarvisIntegrationDraft; connectorId: string; toolIds: string[] }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/engineer/${draftId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    }),
  );
}

export type JarvisRecipeField = {
  key: string;
  label: string;
  help: string;
  href?: string;
  secret?: boolean;
};

export type JarvisIntegrationRecipe = {
  slug: string;
  displayName: string;
  aliases: string[];
  purpose: string;
  baseUrl: string | null;
  recommendedAuth: { kind: string; oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[] } };
  requiredFields: JarvisRecipeField[];
  fallbackAuth: { auth: { kind: string }; fields: JarvisRecipeField[] } | null;
  steps: string[];
  docs: Array<{ title: string; url: string }>;
  operations: Array<{ toolId: string; method: string; path: string; risk: string }>;
  credentialKind: string;
  source: "catalog" | "learned" | "ai";
  confidence: number;
  successCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
};

export async function recommendJarvisConnection(
  token: string,
  input: { product?: string; purpose?: string },
) {
  return parse<{ recipe: JarvisIntegrationRecipe; source: "catalog" | "learned" | "ai" }>(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/integrations/recommend`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function executeClientTool(tool: string, args: Record<string, unknown>) {
  if (tool !== "desktop.open_service") {
    throw new Error(`unsupported client tool ${tool}`);
  }
  const serviceId = String(args.serviceId ?? "");
  const target = resolveJarvisOpenService(serviceId);
  if (!target) {
    throw new Error("unknown serviceId");
  }
  if (target.kind === "service") {
    const service = getServiceById(target.id);
    if (!service) {
      throw new Error("unknown serviceId");
    }
    return { opened: { kind: "service", service } };
  }
  return { opened: target };
}

export async function executeNativeEnvelope(envelope: JarvisEnvelope) {
  return invoke<{
    status: "succeeded" | "failed";
    result: unknown;
    executedAt: string;
    deviceSignature: string;
    toolInvocationId: string;
    requestId: string;
  }>("jarvis_execute_envelope", { envelope });
}

export async function postJarvisToolResult(
  token: string,
  runId: string,
  payload: {
    toolInvocationId: string;
    requestId: string;
    status: "succeeded" | "failed";
    result: unknown;
    executedAt: string;
    deviceSignature: string;
  },
) {
  return parse(
    await jarvisFetch(`${JARVIS_API_BASE}/api/v1/runs/${runId}/tool-results`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}
