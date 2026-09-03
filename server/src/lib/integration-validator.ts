import {
  assertSafeOrigin,
  fetchWithRetry,
  sanitizeOrigin,
  type ConnectorFetch,
  type LookupFn,
} from "./connectors.ts";
import { id } from "./ids.ts";
import { assembleCredential } from "./integration-engineer.ts";
import { transitionDraft } from "./integration-lifecycle.ts";
import type { JarvisStore } from "./store.ts";
import type {
  CredentialKind,
  IntegrationDraft,
  IntegrationValidation,
  IntegrationValidationLevel,
  IntegrationValidationStatus,
  ProposedCapability,
} from "./types.ts";

export type ValidationDeps = { fetch?: ConnectorFetch; lookup?: LookupFn };

export type ValidationOutcome = {
  level: IntegrationValidationLevel;
  status: IntegrationValidationStatus;
  detail: Record<string, unknown>;
};

function authHeaders(kind: CredentialKind | undefined, secret: string | undefined): Record<string, string> {
  if (!secret) {
    return {};
  }
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

function firstReadOp(operations: ProposedCapability[]): ProposedCapability | undefined {
  return operations.find((op) => op.method === "GET" || op.method === "HEAD");
}

/**
 * Layered, non-destructive validation of a proposed integration:
 *   1. schema      — every proposed capability has a method + path
 *   2. connection  — base URL is a safe, reachable HTTPS origin
 *   3. auth        — one safe read authenticates (not 401/403)
 *   4. safe_read   — that read returns a body we can parse
 *   5. write_registered — writes are NOT executed; recorded as unverified,
 *                          to be gated by ALLOW_WITH_APPROVAL at run time
 *
 * Never issues a write. Later levels are `skipped` once an earlier one fails.
 *
 * @returns One outcome per level, in order.
 */
export async function validateIntegration(
  input: {
    baseUrl: string;
    authKind?: CredentialKind;
    secret?: string;
    operations: ProposedCapability[];
  },
  deps: ValidationDeps = {},
): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = [];
  const writes = input.operations.filter((op) => op.risk === "external_write" || op.risk === "destructive");

  // 1. schema
  const malformed = input.operations.filter((op) => !op.method || !op.path);
  const schemaOk = input.operations.length > 0 && malformed.length === 0;
  outcomes.push({
    level: "schema",
    status: schemaOk ? "passed" : "failed",
    detail: { operations: input.operations.length, malformed: malformed.length },
  });
  if (!schemaOk) {
    return withSkipped(outcomes, ["connection", "auth", "safe_read", "write_registered"]);
  }

  // 2. connection
  let origin: string;
  try {
    origin = sanitizeOrigin(input.baseUrl);
    await assertSafeOrigin(origin, deps.lookup);
  } catch (error) {
    outcomes.push({
      level: "connection",
      status: "failed",
      detail: { error: error instanceof Error ? error.message : "unreachable" },
    });
    return withSkipped(outcomes, ["auth", "safe_read", "write_registered"]);
  }
  outcomes.push({ level: "connection", status: "passed", detail: { origin } });

  const read = firstReadOp(input.operations);
  const headers = authHeaders(input.authKind, input.secret);

  // 3. auth + 4. safe_read (share one live GET)
  if (!read) {
    outcomes.push({ level: "auth", status: "skipped", detail: { reason: "no safe read operation" } });
    outcomes.push({ level: "safe_read", status: "skipped", detail: { reason: "no safe read operation" } });
  } else {
    const target = new URL(read.path, `${origin.replace(/\/$/, "")}/`);
    try {
      const response = await fetchWithRetry(
        target.toString(),
        { method: "GET", headers: { "Content-Type": "application/json", ...headers } },
        deps.fetch,
      );
      if (response.status === 401 || response.status === 403) {
        outcomes.push({ level: "auth", status: "failed", detail: { status: response.status } });
        outcomes.push({ level: "safe_read", status: "skipped", detail: { reason: "auth failed" } });
      } else {
        outcomes.push({ level: "auth", status: "passed", detail: { status: response.status } });
        const text = await response.text();
        let parsable = true;
        try {
          JSON.parse(text);
        } catch {
          parsable = false;
        }
        outcomes.push({
          level: "safe_read",
          status: response.status < 400 ? "passed" : "failed",
          detail: { status: response.status, json: parsable },
        });
      }
    } catch (error) {
      outcomes.push({
        level: "auth",
        status: "failed",
        detail: { error: error instanceof Error ? error.message : "connection_failed" },
      });
      outcomes.push({ level: "safe_read", status: "skipped", detail: { reason: "connection failed" } });
    }
  }

  // 5. writes are registered but never executed
  outcomes.push({
    level: "write_registered",
    status: writes.length > 0 ? "skipped" : "passed",
    detail: {
      unverifiedWrites: writes.map((op) => op.toolId),
      policy: writes.length > 0 ? "ALLOW_WITH_APPROVAL" : "none",
    },
  });
  return outcomes;
}

function withSkipped(
  outcomes: ValidationOutcome[],
  levels: IntegrationValidationLevel[],
): ValidationOutcome[] {
  for (const level of levels) {
    outcomes.push({ level, status: "skipped", detail: { reason: "earlier level failed" } });
  }
  return outcomes;
}

/**
 * Run validation for a REVIEW_REQUIRED draft, persist the per-level rows, and
 * move the draft to a failure state or back to REVIEW_REQUIRED. Called with the
 * candidate credential so auth can be exercised before the secret is sealed.
 *
 * @returns The recorded validation rows.
 */
export async function validateDraft(
  store: JarvisStore,
  draft: IntegrationDraft,
  input: { secret?: string; fields?: Record<string, string> },
  deps: ValidationDeps = {},
): Promise<IntegrationValidation[]> {
  if (draft.status === "REVIEW_REQUIRED") {
    transitionDraft(draft, "VALIDATING");
  }
  const authKind = (draft.discoveredAuth?.kind as CredentialKind | undefined) ?? undefined;
  // Collapse multi-field inputs (header maps, MCP serverUrl + token) into the
  // single sealed secret the validator exercises, exactly as register() will.
  const assembled = authKind
    ? assembleCredential(authKind, { secret: input.secret, fields: input.fields })
    : { secret: input.secret ?? "", origin: undefined as string | undefined };
  const outcomes = await validateIntegration(
    {
      baseUrl: assembled.origin ?? draft.baseUrl ?? "",
      authKind,
      secret: assembled.secret || input.secret,
      operations: draft.proposedCapabilities,
    },
    deps,
  );
  const rows: IntegrationValidation[] = outcomes.map((outcome) => ({
    id: id("ivl"),
    draftId: draft.id,
    level: outcome.level,
    status: outcome.status,
    detail: outcome.detail,
    createdAt: new Date().toISOString(),
  }));
  for (const row of rows) {
    store.integrationValidations.set(row.id, row);
  }
  const failed = (level: IntegrationValidationLevel) =>
    outcomes.some((row) => row.level === level && row.status === "failed");
  draft.validationState = outcomes.map((row) => `${row.level}:${row.status}`).join(",");
  if (failed("connection")) {
    transitionDraft(draft, "CONNECTION_FAILED");
  } else if (failed("auth")) {
    transitionDraft(draft, "AUTH_FAILED");
  } else if (failed("schema") || failed("safe_read")) {
    transitionDraft(draft, "VALIDATION_FAILED");
  } else {
    transitionDraft(draft, "REVIEW_REQUIRED");
  }
  draft.updatedAt = new Date().toISOString();
  return rows;
}
