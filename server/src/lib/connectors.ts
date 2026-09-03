import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { recordConnectorHealth } from "./connector-health.ts";
import { recordCapabilityVersion, recordConnectorVersion } from "./connector-versions.ts";
import { hmacSha256Hex, openSecret, sealSecret, sha256Hex, timingSafeEqualText } from "./crypto.ts";
import { id } from "./ids.ts";
import type { JarvisStore } from "./store.ts";
import type {
  Capability,
  CapabilityBinding,
  CapabilityVersion,
  Connector,
  ConnectorKind,
  ConnectorPurpose,
  ConnectorVersion,
  Credential,
  CredentialKind,
  ToolRisk,
  ToolSide,
} from "./types.ts";

export type ConnectorFetch = typeof fetch;
export type LookupFn = typeof lookup;

const BLOCKED_V4 = /^(127\.|10\.|0\.|169\.254\.|192\.168\.)/;

function isBlockedIp(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value.startsWith("::ffff:")) {
    return isBlockedIp(value.slice(7));
  }
  if (value === "::1" || value === "::") {
    return true;
  }
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }
  if (BLOCKED_V4.test(value)) {
    return true;
  }
  const parts = value.split(".").map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  return false;
}

export function sanitizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("egress_denied");
  }
  if (url.username || url.password) {
    throw new Error("egress_denied");
  }
  if (isIP(url.hostname)) {
    throw new Error("egress_denied");
  }
  return `${url.protocol}//${url.host}`;
}

export async function assertSafeOrigin(
  origin: string,
  resolve: LookupFn = lookup,
): Promise<URL> {
  const url = new URL(sanitizeOrigin(origin));
  const answers = await resolve(url.hostname, { all: true });
  for (const answer of answers) {
    if (isBlockedIp(answer.address)) {
      throw new Error("egress_denied");
    }
  }
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchFn: ConnectorFetch = fetch,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        ...init,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
      if (response.status >= 500 && attempt < 2) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === "egress_denied") {
        throw error;
      }
      lastError = error;
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("connector_unavailable");
}

export type VaultKeys = {
  vaultKey: Buffer;
  vaultKeyPrevious?: Buffer | null;
};

export function redactConnectorResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return { ok: true };
  }
  const row = result as Record<string, unknown>;
  if (Array.isArray(row.segments)) {
    return {
      total: Number(row.total ?? 0),
      segments: (row.segments as Array<Record<string, unknown>>).map((segment) => ({
        country: String(segment.country ?? ""),
        language: String(segment.language ?? ""),
        count: Number(segment.count ?? 0),
      })),
    };
  }
  if (Array.isArray(row.items)) {
    return { count: row.items.length };
  }
  if (typeof row.error === "string") {
    return { error: row.error };
  }
  return { ok: true };
}

function credentialPlaintext(store: JarvisStore, keys: VaultKeys, credential: Credential): string {
  return openSecret({
    sealed: credential.sealed,
    masterKey: keys.vaultKey,
    previousKey: keys.vaultKeyPrevious,
    orgId: credential.orgId,
    recordId: credential.id,
    kind: credential.kind,
    keyVersion: credential.keyVersion,
  });
}

function authHeaders(kind: CredentialKind, secret: string): Record<string, string> {
  if (kind === "basic") {
    return { Authorization: `Basic ${secret}` };
  }
  if (kind === "header_map") {
    try {
      return JSON.parse(secret) as Record<string, string>;
    } catch {
      return { Authorization: `Bearer ${secret}` };
    }
  }
  return { Authorization: `Bearer ${secret}` };
}

export type AttachConnectorInput = {
  orgId: string;
  createdBy: string;
  kind: ConnectorKind;
  name: string;
  purpose?: ConnectorPurpose;
  origin: string;
  credential: { label: string; kind: CredentialKind; secret: string };
  operations: Array<{
    toolId: string;
    side?: ToolSide;
    risk: ToolRisk;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    binding: CapabilityBinding;
  }>;
};

export function attachConnector(
  store: JarvisStore,
  keys: VaultKeys,
  input: AttachConnectorInput,
): {
  connector: Connector;
  credential: Credential;
  capabilities: Capability[];
  connectorVersion: ConnectorVersion;
  capabilityVersions: CapabilityVersion[];
} {
  const origin = sanitizeOrigin(input.origin);
  const existingCred = [...store.credentials.values()].find(
    (row) => row.orgId === input.orgId && row.label === input.credential.label && !row.revokedAt,
  );
  const credential: Credential = existingCred ?? {
    id: id("crd"),
    orgId: input.orgId,
    label: input.credential.label,
    kind: input.credential.kind,
    sealed: "",
    keyVersion: 1,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    rotatedAt: null,
    revokedAt: null,
  };
  credential.sealed = sealSecret({
    plaintext: input.credential.secret,
    masterKey: keys.vaultKey,
    orgId: input.orgId,
    recordId: credential.id,
    kind: credential.kind,
  });
  store.credentials.set(credential.id, credential);

  const specHash = sha256Hex(
    JSON.stringify({
      origin,
      operations: input.operations.map((row) => ({ toolId: row.toolId, binding: row.binding, risk: row.risk })),
    }),
  );
  const existing = [...store.connectors.values()].find(
    (row) => row.orgId === input.orgId && row.name === input.name,
  );
  const connector: Connector = existing
    ? {
        ...existing,
        kind: input.kind,
        status: "active",
        revision: existing.specHash === specHash ? existing.revision : existing.revision + 1,
        credentialId: credential.id,
        publicConfig: { origin, purpose: input.purpose, operationIds: input.operations.map((row) => row.toolId) },
        specHash,
      }
    : {
        id: id("con"),
        orgId: input.orgId,
        kind: input.kind,
        name: input.name,
        status: "active",
        revision: 1,
        credentialId: credential.id,
        publicConfig: { origin, purpose: input.purpose, operationIds: input.operations.map((row) => row.toolId) },
        specHash,
        authSealed: null,
        createdAt: new Date().toISOString(),
      };
  store.connectors.set(connector.id, connector);

  const capabilities: Capability[] = [];
  for (const operation of input.operations) {
    const current = store.enabledCapability(input.orgId, operation.toolId);
    const changed =
      !current ||
      JSON.stringify(current.binding) !== JSON.stringify(operation.binding) ||
      current.risk !== operation.risk ||
      current.connectorId !== connector.id;
    if (current && changed) {
      current.enabled = false;
    }
    if (current && !changed) {
      capabilities.push(current);
      continue;
    }
    const version = (current?.version ?? 0) + 1;
    const capability: Capability = {
      id: id("cap"),
      orgId: input.orgId,
      connectorId: connector.id,
      toolId: operation.toolId,
      version,
      side: operation.side ?? "cloud",
      risk: operation.risk,
      inputSchema: operation.inputSchema ?? {},
      outputSchema: operation.outputSchema ?? {},
      binding: operation.binding,
      enabled: true,
    };
    store.capabilities.set(capability.id, capability);
    capabilities.push(capability);
  }

  const connectorVersion = recordConnectorVersion(store, connector);
  const capabilityVersions = capabilities.map((capability) =>
    recordCapabilityVersion(store, capability, connectorVersion.id),
  );
  return { connector, credential, capabilities, connectorVersion, capabilityVersions };
}

export type UpdateConnectorInput = {
  orgId: string;
  connectorId: string;
  name?: string;
  origin?: string;
  secret?: string;
};

/**
 * Edit a live connector: rename, retarget origin, and/or rotate the sealed
 * credential. Origin changes bump revision and record a new version snapshot.
 */
export function updateConnector(
  store: JarvisStore,
  keys: VaultKeys,
  input: UpdateConnectorInput,
): Connector {
  const connector = store.connectors.get(input.connectorId);
  if (!connector || connector.orgId !== input.orgId || connector.status !== "active") {
    throw new Error("connector_missing");
  }
  const name = input.name?.trim();
  const origin = input.origin ? sanitizeOrigin(input.origin) : connector.publicConfig.origin;
  const originChanged = origin !== connector.publicConfig.origin;
  if (name) {
    connector.name = name;
  }
  if (originChanged) {
    connector.publicConfig = { ...connector.publicConfig, origin };
    connector.revision += 1;
    connector.specHash = sha256Hex(
      JSON.stringify({ origin, operationIds: connector.publicConfig.operationIds }),
    );
    recordConnectorVersion(store, connector);
  }
  if (input.secret && connector.credentialId) {
    const credential = store.credentials.get(connector.credentialId);
    if (credential && !credential.revokedAt) {
      credential.sealed = sealSecret({
        plaintext: input.secret,
        masterKey: keys.vaultKey,
        orgId: credential.orgId,
        recordId: credential.id,
        kind: credential.kind,
      });
      credential.rotatedAt = new Date().toISOString();
    }
  }
  store.connectors.set(connector.id, connector);
  return connector;
}

/**
 * Soft-remove a connector: disable it, drop its capabilities, revoke the
 * credential, and mark health DISABLED so the resolver reports a gap.
 */
export function removeConnector(
  store: JarvisStore,
  input: { orgId: string; connectorId: string },
): Connector {
  const connector = store.connectors.get(input.connectorId);
  if (!connector || connector.orgId !== input.orgId) {
    throw new Error("connector_missing");
  }
  connector.status = "disabled";
  store.connectors.set(connector.id, connector);
  for (const capability of store.capabilities.values()) {
    if (capability.connectorId === connector.id && capability.enabled) {
      capability.enabled = false;
    }
  }
  if (connector.credentialId) {
    const credential = store.credentials.get(connector.credentialId);
    if (credential && !credential.revokedAt) {
      credential.revokedAt = new Date().toISOString();
    }
  }
  recordConnectorHealth(store, {
    orgId: connector.orgId,
    connectorId: connector.id,
    state: "DISABLED",
    detail: "removed",
  });
  return connector;
}

export async function discoverMcpTools(
  origin: string,
  headers: Record<string, string>,
  deps: { fetch?: ConnectorFetch; lookup?: LookupFn } = {},
): Promise<Array<{ name: string; inputSchema?: Record<string, unknown> }>> {
  await assertSafeOrigin(origin, deps.lookup);
  const response = await fetchWithRetry(
    `${origin.replace(/\/$/, "")}/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    },
    deps.fetch,
  );
  const body = (await response.json()) as {
    result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> };
  };
  return body.result?.tools ?? [];
}

export async function executeCapability(
  store: JarvisStore,
  keys: VaultKeys,
  orgId: string,
  toolId: string,
  args: Record<string, unknown>,
  deps: { fetch?: ConnectorFetch; lookup?: LookupFn } = {},
): Promise<unknown> {
  const capability = store.enabledCapability(orgId, toolId);
  if (!capability) {
    return { error: "capability_missing" };
  }
  const connector = store.connectors.get(capability.connectorId);
  if (!connector || connector.status !== "active") {
    return { error: "connector_missing" };
  }
  const origin = connector.publicConfig.origin;
  await assertSafeOrigin(origin, deps.lookup);
  const credential = connector.credentialId ? store.credentials.get(connector.credentialId) : undefined;
  const secret = credential ? credentialPlaintext(store, keys, credential) : "";
  const headers = credential ? authHeaders(credential.kind, secret) : {};

  if (connector.kind === "mcp") {
    const response = await fetchWithRetry(
      `${origin.replace(/\/$/, "")}/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: capability.binding.mcpName ?? toolId, arguments: args },
        }),
      },
      deps.fetch,
    );
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return { error: body.error.message ?? "mcp_failed" };
    }
    return body.result ?? { ok: true };
  }

  const method = (capability.binding.method ?? "GET").toUpperCase();
  const path = capability.binding.path ?? "/";
  const target = new URL(path, `${origin.replace(/\/$/, "")}/`);
  if (target.origin !== new URL(origin).origin) {
    throw new Error("egress_denied");
  }
  const response = await fetchWithRetry(
    target.toString(),
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(args),
    },
    deps.fetch,
  );
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text.slice(0, 200) };
  }
}

export function webhookSignature(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return hmacSha256Hex(secret, `${timestamp}.${nonce}.${rawBody}`);
}

export function verifyWebhook(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): "ok" | "stale" | "unauthorized" {
  const now = input.nowMs ?? Date.now();
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300_000) {
    return "stale";
  }
  const expected = webhookSignature(input.secret, input.timestamp, input.nonce, input.rawBody);
  return timingSafeEqualText(expected, input.signature) ? "ok" : "unauthorized";
}
