import { recordConnectorHealth } from "./connector-health.ts";
import { attachConnector, discoverMcpTools, type ConnectorFetch, type LookupFn, type VaultKeys } from "./connectors.ts";
import { sha256Hex } from "./crypto.ts";
import { id } from "./ids.ts";
import { transitionDraft } from "./integration-lifecycle.ts";
import { grantConnectorTools } from "./integrations.ts";
import { recipeFromDraft, rememberRecipe } from "./recipes.ts";
import type { JarvisStore } from "./store.ts";
import type {
  Connector,
  ConnectorPurpose,
  CredentialKind,
  DiscoveredOperation,
  IntegrationDraft,
  IntegrationSource,
  IntegrationSourceType,
  ProposedCapability,
  ToolRisk,
} from "./types.ts";

/**
 * Normalized shape every source parser produces. The pipeline reasons about
 * this, never the raw source, so adding a new source format is a new parser
 * and nothing else.
 */
export type ParsedApi = {
  baseUrl: string | null;
  auth: { kind: CredentialKind | "unknown"; detail?: string } | null;
  operations: DiscoveredOperation[];
};

/** Optional model-backed parser for free-text docs (documentation URL / uploaded / manual). */
export type DocParser = (content: string) => Promise<ParsedApi | null>;

export type EngineerDeps = {
  fetch?: ConnectorFetch;
  lookup?: LookupFn;
  docParser?: DocParser;
};

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "api";
}

/** Create a fresh DRAFT for an integration the engineer will assemble. */
export function createDraft(
  store: JarvisStore,
  input: { orgId: string; createdBy: string; name: string },
): IntegrationDraft {
  const draft: IntegrationDraft = {
    id: id("drf"),
    orgId: input.orgId,
    name: input.name,
    sourceType: null,
    status: "DRAFT",
    specHash: null,
    baseUrl: null,
    discoveredAuth: null,
    discoveredOperations: [],
    proposedCapabilities: [],
    validationState: null,
    questions: [],
    createdBy: input.createdBy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.integrationDrafts.set(draft.id, draft);
  return draft;
}

/** Attach a documentation source to a draft (OpenAPI / Postman / MCP / docs URL / curl / manual). */
export function addSource(
  store: JarvisStore,
  draft: IntegrationDraft,
  input: { type: IntegrationSourceType; ref?: string; content?: string },
): IntegrationSource {
  const source: IntegrationSource = {
    id: id("src"),
    draftId: draft.id,
    type: input.type,
    ref: input.ref ?? null,
    content: input.content ?? null,
    sha: input.content ? sha256Hex(input.content) : null,
    createdAt: nowIso(),
  };
  store.integrationSources.set(source.id, source);
  if (!draft.sourceType) {
    draft.sourceType = input.type;
  }
  draft.updatedAt = nowIso();
  return source;
}

// --- Source parsers (deterministic) -----------------------------------------

function toRisk(method: string): ToolRisk {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return "sensitive_read";
  }
  if (upper === "DELETE") {
    return "destructive";
  }
  return "external_write";
}

function pathResource(path: string): string {
  const segments = path
    .split(/[/?]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && !seg.startsWith("{") && !seg.startsWith(":"));
  return slugify(segments.at(-1) ?? "root");
}

function actionFor(method: string, path: string): string {
  const upper = method.toUpperCase();
  const endsWithParam = /[}:][^/]*$/.test(path.replace(/\/$/, ""));
  if (upper === "GET" || upper === "HEAD") {
    return endsWithParam ? "get" : "list";
  }
  if (upper === "DELETE") {
    return "delete";
  }
  if (upper === "PUT" || upper === "PATCH") {
    return "update";
  }
  return "create";
}

function authFromSecuritySchemes(schemes: Record<string, unknown> | undefined): ParsedApi["auth"] {
  if (!schemes) {
    return null;
  }
  for (const value of Object.values(schemes)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const scheme = value as { type?: string; scheme?: string };
    if (scheme.type === "http" && scheme.scheme === "basic") {
      return { kind: "basic" };
    }
    if (scheme.type === "http") {
      return { kind: "bearer" };
    }
    if (scheme.type === "apiKey") {
      return { kind: "header_map", detail: "apiKey" };
    }
    if (scheme.type === "oauth2") {
      return { kind: "bearer", detail: "oauth2" };
    }
  }
  return null;
}

/** Parse an OpenAPI JSON document into the normalized model. */
export function parseOpenApi(content: string): ParsedApi | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    // ponytail: JSON only. YAML OpenAPI needs a parser dep; defer until a
    // real YAML source appears — the pipeline treats an unparseable doc as
    // INVALID_SPEC, which is the honest outcome.
    return null;
  }
  if (!doc || typeof doc !== "object") {
    return null;
  }
  const spec = doc as {
    servers?: Array<{ url?: string }>;
    paths?: Record<string, Record<string, { operationId?: string; summary?: string }>>;
    components?: { securitySchemes?: Record<string, unknown> };
  };
  if (!spec.paths || typeof spec.paths !== "object") {
    return null;
  }
  const baseUrl = spec.servers?.[0]?.url ?? null;
  const operations: DiscoveredOperation[] = [];
  const methods = ["get", "post", "put", "patch", "delete", "head"];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    for (const method of methods) {
      const op = (item as Record<string, { operationId?: string; summary?: string }>)[method];
      if (!op) {
        continue;
      }
      operations.push({
        externalId: op.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        risk: toRisk(method),
      });
    }
  }
  return {
    baseUrl: baseUrl && baseUrl.startsWith("http") ? baseUrl : baseUrl,
    auth: authFromSecuritySchemes(spec.components?.securitySchemes),
    operations,
  };
}

/** Parse a Postman collection (v2) into the normalized model. */
export function parsePostman(content: string): ParsedApi | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return null;
  }
  const root = doc as { item?: unknown };
  if (!Array.isArray(root.item)) {
    return null;
  }
  const operations: DiscoveredOperation[] = [];
  let baseUrl: string | null = null;
  const walk = (items: unknown[]): void => {
    for (const raw of items) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const node = raw as {
        name?: string;
        item?: unknown[];
        request?: { method?: string; url?: { raw?: string } | string };
      };
      if (Array.isArray(node.item)) {
        walk(node.item);
        continue;
      }
      if (!node.request) {
        continue;
      }
      const method = (node.request.method ?? "GET").toUpperCase();
      const rawUrl = typeof node.request.url === "string" ? node.request.url : node.request.url?.raw ?? "";
      let path = rawUrl;
      try {
        const url = new URL(rawUrl);
        if (!baseUrl) {
          baseUrl = `${url.protocol}//${url.host}`;
        }
        path = url.pathname || "/";
      } catch {
        path = rawUrl || "/";
      }
      operations.push({
        externalId: node.name ?? `${method} ${path}`,
        method,
        path,
        summary: node.name,
        risk: toRisk(method),
      });
    }
  };
  walk(root.item);
  return { baseUrl, auth: null, operations };
}

/** Parse a single `curl` command into one operation. */
export function parseCurl(content: string): ParsedApi | null {
  const urlMatch = content.match(/https?:\/\/[^\s'"]+/);
  if (!urlMatch) {
    return null;
  }
  const methodMatch = content.match(/-X\s+([A-Za-z]+)/) ?? content.match(/--request\s+([A-Za-z]+)/);
  const hasData = /(-d|--data|--data-raw|--data-binary)\b/.test(content);
  const method = (methodMatch?.[1] ?? (hasData ? "POST" : "GET")).toUpperCase();
  let baseUrl: string | null = null;
  let path = "/";
  try {
    const url = new URL(urlMatch[0]);
    baseUrl = `${url.protocol}//${url.host}`;
    path = url.pathname || "/";
  } catch {
    return null;
  }
  const authHeader = content.match(/-H\s+['"]?authorization:\s*([^'"\n]+)/i)?.[1]?.trim();
  const auth: ParsedApi["auth"] = authHeader
    ? { kind: /^basic/i.test(authHeader) ? "basic" : "bearer", detail: "from curl header" }
    : null;
  return {
    baseUrl,
    auth,
    operations: [
      { externalId: `${method} ${path}`, method, path, risk: toRisk(method) },
    ],
  };
}

/** Discover MCP tools live and map them to operations. */
export async function parseMcp(
  origin: string,
  headers: Record<string, string>,
  deps: EngineerDeps = {},
): Promise<ParsedApi> {
  const tools = await discoverMcpTools(origin, headers, deps);
  return {
    baseUrl: origin,
    auth: { kind: "mcp" },
    operations: tools.map((tool) => ({
      externalId: tool.name,
      method: "MCP",
      path: tool.name,
      risk: "external_write" as ToolRisk,
    })),
  };
}

// --- Capability mapping ------------------------------------------------------

/**
 * Map a discovered operation to a canonical capability. Deterministic and
 * offline: id is `<slug>.<resource>.<action>`, confidence reflects how much
 * signal the source gave us. Phase 3's model hook can refine this later.
 */
export function mapCapability(slug: string, op: DiscoveredOperation): ProposedCapability {
  const isMcp = op.method === "MCP";
  const resource = isMcp ? slugify(op.path) : pathResource(op.path);
  const action = isMcp ? "call" : actionFor(op.method, op.path);
  const capabilityId = isMcp ? `${slug}.${resource}` : `${slug}.${resource}.${action}`;
  const hasOperationId = !/^[A-Z]+ /.test(op.externalId);
  const confidence = hasOperationId ? 0.9 : op.summary ? 0.7 : 0.5;
  return {
    capabilityId,
    toolId: capabilityId,
    externalId: op.externalId,
    method: op.method,
    path: op.path,
    risk: op.risk ?? toRisk(op.method),
    confidence,
  };
}

// --- Pipeline ---------------------------------------------------------------

async function parseSource(
  source: IntegrationSource,
  deps: EngineerDeps,
): Promise<ParsedApi | null> {
  const content = source.content ?? "";
  if (source.type === "openapi") {
    return parseOpenApi(content);
  }
  if (source.type === "postman") {
    return parsePostman(content);
  }
  if (source.type === "curl") {
    return parseCurl(content);
  }
  if (source.type === "mcp") {
    const origin = source.ref ?? "";
    if (!origin) {
      return null;
    }
    return parseMcp(origin, {}, deps);
  }
  // documentation_url / uploaded_documentation / manual → model-backed parser.
  if (deps.docParser) {
    return deps.docParser(content || source.ref || "");
  }
  return null;
}

/**
 * Run discovery over the draft's most recent source and advance the lifecycle.
 * Missing base URL / auth moves the draft to DOCS_REQUIRED / AUTH_REQUIRED with
 * explicit questions; a complete parse compiles capabilities and moves to
 * REVIEW_REQUIRED.
 *
 * @returns The mutated draft.
 */
export async function discover(
  store: JarvisStore,
  draft: IntegrationDraft,
  deps: EngineerDeps = {},
): Promise<IntegrationDraft> {
  if (draft.status === "DRAFT") {
    transitionDraft(draft, "DISCOVERING");
  }
  const source = store.sourcesForDraft(draft.id).at(-1);
  const parsed = source ? await parseSource(source, deps) : null;
  if (!parsed || parsed.operations.length === 0) {
    draft.questions = [
      "I couldn't read any operations from that source. Paste an OpenAPI/Postman export, a curl example, or an MCP endpoint.",
    ];
    transitionDraft(draft, "DOCS_REQUIRED");
    draft.specHash = source?.sha ?? draft.specHash;
    return draft;
  }
  draft.baseUrl = parsed.baseUrl ?? draft.baseUrl;
  draft.discoveredOperations = parsed.operations;
  draft.specHash = source?.sha ?? draft.specHash;
  if (parsed.auth && parsed.auth.kind !== "unknown") {
    draft.discoveredAuth = { kind: parsed.auth.kind, detail: parsed.auth.detail ?? null };
  }
  if (!draft.baseUrl) {
    draft.questions = ["What is the API base URL (https://…)?"];
    transitionDraft(draft, "DOCS_REQUIRED");
    return draft;
  }
  if (!draft.discoveredAuth) {
    draft.questions = [
      "The docs don't specify authentication. Which does this API use — API key, Bearer token, or Basic auth?",
    ];
    transitionDraft(draft, "AUTH_REQUIRED");
    return draft;
  }
  return propose(draft);
}

/**
 * Answer an open question. Currently handles base URL and auth kind; both let
 * a DOCS_REQUIRED / AUTH_REQUIRED draft resume toward REVIEW_REQUIRED.
 *
 * @returns The mutated draft.
 */
export function answer(
  draft: IntegrationDraft,
  input: { baseUrl?: string; authKind?: CredentialKind },
): IntegrationDraft {
  if (input.baseUrl) {
    draft.baseUrl = input.baseUrl;
  }
  if (input.authKind) {
    draft.discoveredAuth = { kind: input.authKind };
  }
  draft.updatedAt = nowIso();
  if (draft.discoveredOperations.length === 0) {
    // Still need a usable source; route the user back to discovery.
    if (draft.status !== "DOCS_REQUIRED") {
      transitionDraft(draft, "DOCS_REQUIRED");
    }
    return draft;
  }
  if (!draft.baseUrl) {
    draft.questions = ["What is the API base URL (https://…)?"];
    if (draft.status !== "DOCS_REQUIRED") {
      transitionDraft(draft, draft.status === "AUTH_REQUIRED" ? "DISCOVERING" : "DOCS_REQUIRED");
    }
    return draft;
  }
  if (!draft.discoveredAuth) {
    draft.questions = ["Which authentication does this API use — API key, Bearer token, or Basic auth?"];
    if (draft.status === "DOCS_REQUIRED") {
      transitionDraft(draft, "DISCOVERING");
    }
    if (draft.status !== "AUTH_REQUIRED") {
      transitionDraft(draft, "AUTH_REQUIRED");
    }
    return draft;
  }
  // From DOCS_REQUIRED we must re-enter DISCOVERING before proposing.
  if (draft.status === "DOCS_REQUIRED") {
    transitionDraft(draft, "DISCOVERING");
  }
  return propose(draft);
}

/**
 * Compile + classify discovered operations into proposed capabilities and move
 * the draft to REVIEW_REQUIRED for human approval.
 *
 * @returns The mutated draft.
 */
export function propose(draft: IntegrationDraft): IntegrationDraft {
  const slug = slugify(draft.name);
  const seen = new Set<string>();
  const proposed: ProposedCapability[] = [];
  for (const op of draft.discoveredOperations) {
    const capability = mapCapability(slug, op);
    let toolId = capability.toolId;
    let suffix = 2;
    while (seen.has(toolId)) {
      toolId = `${capability.toolId}_${suffix}`;
      suffix += 1;
    }
    seen.add(toolId);
    proposed.push({ ...capability, toolId, capabilityId: toolId });
  }
  draft.proposedCapabilities = proposed;
  draft.questions = [];
  if (draft.status === "VALIDATING") {
    transitionDraft(draft, "REVIEW_REQUIRED");
  } else if (draft.status !== "REVIEW_REQUIRED") {
    // DISCOVERING / AUTH_REQUIRED → REVIEW_REQUIRED goes through VALIDATING so
    // Phase 4's validator has a hook; with no validator it's a pass-through.
    if (draft.status === "AUTH_REQUIRED" || draft.status === "DISCOVERING") {
      transitionDraft(draft, "VALIDATING");
    }
    transitionDraft(draft, "REVIEW_REQUIRED");
  }
  draft.updatedAt = nowIso();
  return draft;
}

/** Reserved field keys that are not part of the sealed header credential. */
const RESERVED_FIELD_KEYS = new Set(["serverUrl", "clientId", "clientSecret", "origin", "operations"]);

/**
 * Assemble the sealed credential string (and an optional origin override) from
 * the user-supplied fields, per {@link CredentialKind}. This is what makes
 * "request the correct info" real: multi-part credentials (Gmail MCP's
 * serverUrl + token, a header-key API's name+value) collapse into the single
 * sealed secret the vault stores, parsed back by `authHeaders`.
 */
export function assembleCredential(
  authKind: CredentialKind,
  input: { secret?: string; fields?: Record<string, string> },
): { secret: string; origin?: string } {
  const fields = input.fields ?? {};
  if (authKind === "header_map") {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!RESERVED_FIELD_KEYS.has(key) && value) {
        headers[key] = value;
      }
    }
    const secret = Object.keys(headers).length > 0 ? JSON.stringify(headers) : input.secret ?? "";
    return { secret };
  }
  if (authKind === "mcp") {
    return {
      secret: fields.token ?? fields.secret ?? input.secret ?? "",
      origin: fields.serverUrl?.trim() || undefined,
    };
  }
  return { secret: fields.secret ?? fields.token ?? input.secret ?? "" };
}

/**
 * Register an approved draft as a live connector, sealing the supplied
 * credential and granting the connector's tools to the requesting agent. On a
 * proven connection (validation exercised a live read), the connection recipe
 * is remembered platform-wide — the shape only, never the secret.
 *
 * @throws If the draft is not REVIEW_REQUIRED, or lacks a base URL / operations.
 * @returns The created connector, the tool ids now available, and the learned
 *   recipe slug if one was remembered.
 */
export function register(
  store: JarvisStore,
  keys: VaultKeys,
  draft: IntegrationDraft,
  input: {
    agentId: string;
    createdBy: string;
    secret?: string;
    fields?: Record<string, string>;
    kind?: "openapi" | "mcp";
  },
): { connector: Connector; toolIds: string[]; recipeSlug?: string } {
  if (draft.status !== "REVIEW_REQUIRED") {
    throw new Error(`draft not ready to register (status ${draft.status})`);
  }
  if (!draft.baseUrl) {
    throw new Error("draft missing base url");
  }
  if (draft.proposedCapabilities.length === 0) {
    throw new Error("draft has no proposed capabilities");
  }
  const authKind = (draft.discoveredAuth?.kind as CredentialKind | undefined) ?? "bearer";
  const assembled = assembleCredential(authKind, input);
  if (!assembled.secret) {
    throw new Error("credential_required");
  }
  const kind = input.kind ?? (authKind === "mcp" ? "mcp" : "openapi");
  const attached = attachConnector(store, keys, {
    orgId: draft.orgId,
    createdBy: input.createdBy,
    kind,
    name: slugify(draft.name),
    purpose: "custom" as ConnectorPurpose,
    origin: assembled.origin ?? draft.baseUrl,
    credential: { label: slugify(draft.name), kind: authKind === "mcp" ? "mcp" : authKind, secret: assembled.secret },
    operations: draft.proposedCapabilities.map((cap) => ({
      toolId: cap.toolId,
      risk: cap.risk,
      binding: cap.method === "MCP" ? { mcpName: cap.path } : { method: cap.method, path: cap.path },
    })),
  });
  const toolIds = attached.capabilities.map((row) => row.toolId);
  grantConnectorTools(store, draft.orgId, input.agentId, toolIds);
  recordConnectorHealth(store, { orgId: draft.orgId, connectorId: attached.connector.id, state: "READY" });
  transitionDraft(draft, "READY");

  // Remember only a proven connection: the validator must have exercised a live
  // auth/read against this draft before we publish the recipe platform-wide.
  const state = draft.validationState ?? "";
  const proven = state.includes("auth:passed") || state.includes("safe_read:passed");
  let recipeSlug: string | undefined;
  if (proven) {
    const captured = input.fields ?? (input.secret ? { secret: input.secret } : {});
    const recipe = rememberRecipe(store, recipeFromDraft(draft, captured));
    recipeSlug = recipe.slug;
  }
  return { connector: attached.connector, toolIds, recipeSlug };
}
