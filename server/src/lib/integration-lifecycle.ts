import type { IntegrationDraft, IntegrationDraftStatus } from "./types.ts";

/**
 * Allowed transitions of the integration draft lifecycle. The happy path is
 * DRAFT → DISCOVERING → (DOCS/AUTH_REQUIRED) → VALIDATING → REVIEW_REQUIRED →
 * READY. Failure states are reachable from where they can occur and can retry
 * back into the pipeline. REVOKED is terminal and reachable from anywhere.
 */
const TRANSITIONS: Record<IntegrationDraftStatus, IntegrationDraftStatus[]> = {
  DRAFT: ["DISCOVERING", "REVOKED"],
  DISCOVERING: [
    "DOCS_REQUIRED",
    "AUTH_REQUIRED",
    "VALIDATING",
    "REVIEW_REQUIRED",
    "INVALID_SPEC",
    "REVOKED",
  ],
  DOCS_REQUIRED: ["DISCOVERING", "REVOKED"],
  AUTH_REQUIRED: ["VALIDATING", "DISCOVERING", "REVOKED"],
  VALIDATING: [
    "REVIEW_REQUIRED",
    "AUTH_REQUIRED",
    "AUTH_FAILED",
    "CONNECTION_FAILED",
    "VALIDATION_FAILED",
    "REVOKED",
  ],
  REVIEW_REQUIRED: ["READY", "VALIDATING", "REVOKED"],
  READY: ["VALIDATING", "DISABLED", "REVOKED"],
  INVALID_SPEC: ["DISCOVERING", "REVOKED"],
  AUTH_FAILED: ["AUTH_REQUIRED", "REVOKED"],
  CONNECTION_FAILED: ["VALIDATING", "REVOKED"],
  VALIDATION_FAILED: ["VALIDATING", "DISCOVERING", "REVOKED"],
  DISABLED: ["READY", "REVOKED"],
  REVOKED: [],
};

/** Terminal-ish failure states surfaced verbatim to the user. */
export const DRAFT_FAILURE_STATES: IntegrationDraftStatus[] = [
  "INVALID_SPEC",
  "AUTH_FAILED",
  "CONNECTION_FAILED",
  "VALIDATION_FAILED",
  "DISABLED",
  "REVOKED",
];

/** @returns Whether the draft may move from `from` to `to`. */
export function canTransition(
  from: IntegrationDraftStatus,
  to: IntegrationDraftStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Move a draft to `next`, stamping `updatedAt`. Mutates in place (drafts live
 * in the store's map, mirroring how runs/tasks transition elsewhere).
 *
 * @throws If the transition is not allowed by the state machine.
 */
export function transitionDraft(
  draft: IntegrationDraft,
  next: IntegrationDraftStatus,
): IntegrationDraft {
  if (!canTransition(draft.status, next)) {
    throw new Error(`invalid integration draft transition ${draft.status} -> ${next}`);
  }
  draft.status = next;
  draft.updatedAt = new Date().toISOString();
  return draft;
}
