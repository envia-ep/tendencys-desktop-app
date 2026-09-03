import { getConnectorHealth } from "./connector-health.ts";
import { attachConnector, sanitizeOrigin, type VaultKeys } from "./connectors.ts";
import { id } from "./ids.ts";
import { principalForAgent } from "./org-graph.ts";
import { catalogRecipe, rememberRecipe } from "./recipes.ts";
import {
  CUSTOM_PROVIDER,
  PROVIDERS,
  connectorMatchesPurpose,
  inferIntegrationNeeds,
  presentedAuthMethods,
  providersForPurpose,
  resolveProvider,
  type AuthMethod,
  type IntegrationPurpose,
  type ProviderSpec,
} from "./providers.ts";
import type { JarvisStore } from "./store.ts";
import type { ConnectSession, ConnectorPurpose, ToolRisk } from "./types.ts";

export type IntegrationEnv = Record<string, string | undefined>;

export type ConnectRequired = {
  status: "connect_required";
  connectId: string;
  purpose?: IntegrationPurpose;
  provider: string | null;
  ask?: "product";
  candidates: Array<{ id: string; purposes: IntegrationPurpose[]; fields: AuthMethod["fields"] }>;
  authMethods: AuthMethod[];
  fields: AuthMethod["fields"];
};

export type ConnectConnected = {
  status: "connected";
  provider: string;
  toolIds: string[];
};

export type StatusResult =
  | { status: "connected"; provider: string; toolIds: string[]; purpose?: IntegrationPurpose }
  | { status: "missing"; purpose?: IntegrationPurpose; provider?: string };

function nowIso(): string {
  return new Date().toISOString();
}

export function integrationCatalog(env: IntegrationEnv = {}) {
  return PROVIDERS.map((row) => ({
    id: row.id,
    purposes: row.purposes,
    authMethods: presentedAuthMethods(row, env).map((method) => ({
      kind: method.kind,
      fields: method.fields,
    })),
  }));
}

export function listIntegrations(store: JarvisStore, orgId: string, env: IntegrationEnv = {}) {
  return {
    connectors: store.connectorsFor(orgId)
      .filter((row) => row.status === "active")
      .map((row) => {
        const health = getConnectorHealth(store, row.id);
        const capabilityCount = [...store.capabilities.values()].filter(
          (cap) => cap.connectorId === row.id && cap.enabled,
        ).length;
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          status: row.status,
          revision: row.revision,
          purpose: row.publicConfig.purpose ?? null,
          origin: row.publicConfig.origin,
          capabilityCount,
          health: health?.state ?? "READY",
          healthDetail: health?.detail ?? null,
        };
      }),
    customTools: [...store.customTools.values()]
      .filter((row) => row.orgId === orgId)
      .map((row) => ({
        id: row.id,
        toolId: row.toolId,
        risk: row.risk,
        steps: row.definition.steps.length,
      })),
    catalog: integrationCatalog(env),
  };
}

export function isPurposeConnected(
  store: JarvisStore,
  orgId: string,
  purpose: IntegrationPurpose,
): boolean {
  return store.connectorsFor(orgId).some(
    (row) => row.status === "active" && connectorMatchesPurpose(row.publicConfig.purpose, purpose),
  );
}

export function connectedProvider(
  store: JarvisStore,
  orgId: string,
  providerId: string,
): boolean {
  return store.connectorsFor(orgId).some(
    (row) => row.status === "active" && row.name === providerId,
  );
}

function toolIdsForConnector(store: JarvisStore, orgId: string, providerId: string): string[] {
  const connector = store.connectorsFor(orgId).find((row) => row.status === "active" && row.name === providerId);
  if (!connector) {
    return [];
  }
  return [...store.capabilities.values()]
    .filter((row) => row.orgId === orgId && row.connectorId === connector.id && row.enabled)
    .map((row) => row.toolId);
}

export function integrationStatus(
  store: JarvisStore,
  orgId: string,
  args: { purpose?: string; product?: string },
): StatusResult {
  const needs = inferIntegrationNeeds([args.product, args.purpose].filter(Boolean).join(" "));
  const product = args.product?.trim() || needs.product;
  const purpose = (args.purpose as IntegrationPurpose | undefined) ?? needs.purposes[0];
  if (product) {
    const resolved = resolveProvider({ product });
    const spec = resolved.spec ?? CUSTOM_PROVIDER;
    if (connectedProvider(store, orgId, spec.id)) {
      return { status: "connected", provider: spec.id, toolIds: toolIdsForConnector(store, orgId, spec.id), purpose };
    }
    return { status: "missing", provider: spec.id, purpose };
  }
  if (purpose && isPurposeConnected(store, orgId, purpose)) {
    const connector = store.connectorsFor(orgId).find(
      (row) => row.status === "active" && connectorMatchesPurpose(row.publicConfig.purpose, purpose),
    )!;
    return {
      status: "connected",
      provider: connector.name,
      toolIds: toolIdsForConnector(store, orgId, connector.name),
      purpose,
    };
  }
  return { status: "missing", purpose };
}

function listedCandidates(
  purpose?: IntegrationPurpose,
): Array<{ id: string; purposes: IntegrationPurpose[]; fields: AuthMethod["fields"] }> {
  return (purpose ? providersForPurpose(purpose) : []).map((row) => ({
    id: row.id,
    purposes: row.purposes,
    fields: row.authMethods.find((method) => method.kind === "fields")?.fields ?? [],
  }));
}

export function startConnect(
  store: JarvisStore,
  input: {
    orgId: string;
    agentId: string;
    createdBy: string;
    runId?: string | null;
    product?: string;
    purpose?: string;
    env?: IntegrationEnv;
  },
): ConnectConnected | ConnectRequired {
  const status = integrationStatus(store, input.orgId, {
    product: input.product,
    purpose: input.purpose,
  });
  if (status.status === "connected") {
    return { status: "connected", provider: status.provider, toolIds: status.toolIds };
  }
  const resolved = resolveProvider({
    product: input.product,
    purpose: input.purpose as IntegrationPurpose | undefined,
  });
  const spec = resolved.spec;
  const purpose = (input.purpose as IntegrationPurpose | undefined) ?? spec?.purposes[0];
  const session: ConnectSession = {
    id: id("cnn"),
    orgId: input.orgId,
    runId: input.runId ?? null,
    agentId: input.agentId,
    createdBy: input.createdBy,
    providerId: spec?.id ?? null,
    purpose: purpose ?? null,
    status: "pending",
    oauthState: null,
    toolIds: [],
    fields: {},
    createdAt: nowIso(),
  };
  store.connectSessions.set(session.id, session);
  const env = input.env ?? {};
  const authMethods = spec ? presentedAuthMethods(spec, env) : [];
  return {
    status: "connect_required",
    connectId: session.id,
    purpose,
    provider: spec?.id ?? null,
    ask: resolved.ask,
    candidates: listedCandidates(purpose),
    authMethods,
    fields: authMethods[0]?.fields ?? [],
  };
}

export function isConnectRequired(result: unknown): result is ConnectRequired {
  return Boolean(result && typeof result === "object" && (result as { status?: string }).status === "connect_required");
}

function shopHost(shop: string): string {
  const raw = shop.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return raw.includes(".") ? raw : `${raw}.myshopify.com`;
}

export function resolveOrigin(spec: ProviderSpec, fields: Record<string, string>): string {
  if (typeof spec.origin === "string") {
    return sanitizeOrigin(spec.origin);
  }
  const value = fields[spec.origin.fromField] ?? fields.origin ?? "";
  const filled = spec.origin.template.replace("{origin}", value).replace("{shop}", shopHost(value || "example.myshopify.com"));
  return sanitizeOrigin(filled.startsWith("https://") ? filled : `https://${filled}`);
}

function operationsFrom(spec: ProviderSpec, fields: Record<string, string>) {
  if (spec.id === "custom" && typeof fields.operations === "string" && fields.operations.trim()) {
    try {
      const parsed = JSON.parse(fields.operations) as Array<{
        toolId: string;
        risk?: ToolRisk;
        binding?: { method?: string; path?: string };
      }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((row) => ({
          toolId: row.toolId,
          risk: row.risk ?? "sensitive_read",
          binding: row.binding ?? { method: "GET", path: "/" },
        }));
      }
    } catch {
      // use defaults
    }
  }
  return spec.operations;
}

export function grantConnectorTools(
  store: JarvisStore,
  orgId: string,
  agentId: string,
  toolIds: string[],
): void {
  const principal = principalForAgent(store, orgId, agentId) ?? store.ensureAgentPrincipal(orgId, agentId, agentId);
  for (const toolId of toolIds) {
    store.upsertAccessGrant({ orgId, principalId: principal.id, toolId, kind: "can_use" });
  }
}

export function completeConnect(
  store: JarvisStore,
  keys: VaultKeys,
  input: {
    connectId: string;
    fields: Record<string, string>;
    secret?: string;
    providerId?: string;
  },
): ConnectConnected {
  const session = store.connectSessions.get(input.connectId);
  if (!session || session.status !== "pending") {
    throw new Error("connect_session_missing");
  }
  const product = input.providerId ?? session.providerId ?? input.fields.product ?? "custom";
  const resolved = resolveProvider({ product });
  const spec = resolved.spec ?? CUSTOM_PROVIDER;
  const secret = input.secret ?? input.fields.secret ?? "";
  if (!secret) {
    throw new Error("credential_required");
  }
  const origin = resolveOrigin(spec, input.fields);
  const operations = operationsFrom(spec, input.fields);
  const purpose = session.purpose ?? spec.purposes[0] ?? "custom";
  const attached = attachConnector(store, keys, {
    orgId: session.orgId,
    createdBy: session.createdBy,
    kind: "openapi",
    name: spec.id,
    purpose: purpose as ConnectorPurpose,
    origin,
    credential: { label: spec.id, kind: spec.credentialKind, secret },
    operations,
  });
  const toolIds = attached.capabilities.map((row) => row.toolId);
  grantConnectorTools(store, session.orgId, session.agentId, toolIds);
  session.status = "completed";
  session.providerId = spec.id;
  session.toolIds = toolIds;

  // Remember the proven catalog path platform-wide — the shape only, never the
  // sealed secret. Skip the generic custom fallback (no reusable recipe). Pass
  // the platform env so the remembered method matches what recommendation shows
  // (OAuth one-click only when the OAuth app is configured).
  if (spec.id !== "custom") {
    rememberRecipe(store, catalogRecipe(spec, process.env));
  }
  return { status: "connected", provider: spec.id, toolIds };
}

export function bindOauthState(
  store: JarvisStore,
  connectId: string,
  fields?: Record<string, string>,
): string {
  const session = store.connectSessions.get(connectId);
  if (!session || session.status !== "pending") {
    throw new Error("connect_session_missing");
  }
  if (fields) {
    session.fields = { ...session.fields, ...fields };
  }
  const state = id("oas");
  session.oauthState = state;
  return state;
}

export function connectSessionByOauthState(store: JarvisStore, state: string): ConnectSession | undefined {
  return [...store.connectSessions.values()].find((row) => row.oauthState === state);
}

export function pendingConnectForRun(store: JarvisStore, runId: string): ConnectSession | undefined {
  return [...store.connectSessions.values()].find((row) => row.runId === runId && row.status === "pending");
}

export function completedConnectForRun(store: JarvisStore, runId: string): ConnectSession | undefined {
  return [...store.connectSessions.values()]
    .filter((row) => row.runId === runId && row.status === "completed")
    .at(-1);
}

function fillUrl(template: string, fields: Record<string, string>): string {
  return template.replace("{shop}", shopHost(fields.shop ?? fields.origin ?? ""));
}

export function buildAuthorizeUrl(input: {
  spec: ProviderSpec;
  env: IntegrationEnv;
  redirectUri: string;
  state: string;
  fields: Record<string, string>;
}): string {
  const oauth = input.spec.authMethods.find((row) => row.kind === "oauth")?.oauth;
  // The user may supply their own client id/secret when the env vars are unset
  // (Gmail MCP-style), so accept either source of a configured client.
  const clientId = (input.env[oauth?.envClientId ?? ""] ?? "").trim() || (input.fields.clientId ?? "").trim();
  if (!oauth || !clientId) {
    throw new Error("oauth_not_configured");
  }
  const url = new URL(fillUrl(oauth.authorizeUrl, input.fields));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", oauth.scopes.join(" "));
  return url.toString();
}

export async function exchangeOauthToken(input: {
  spec: ProviderSpec;
  env: IntegrationEnv;
  redirectUri: string;
  code: string;
  fields: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const oauth = input.spec.authMethods.find((row) => row.kind === "oauth")?.oauth;
  if (!oauth) {
    throw new Error("oauth_not_configured");
  }
  const tokenUrl = fillUrl(oauth.tokenUrl, input.fields);
  const response = await (input.fetchFn ?? fetch)(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: (input.env[oauth.envClientId] ?? "").trim() || (input.fields.clientId ?? "").trim(),
      client_secret: (input.env[oauth.envClientSecret] ?? "").trim() || (input.fields.clientSecret ?? "").trim(),
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { access_token?: string; accessToken?: string };
  const token = body.access_token ?? body.accessToken;
  if (!token) {
    throw new Error("oauth_token_missing");
  }
  return token;
}
