import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canTransition, transitionDraft } from "./integration-lifecycle.ts";
import type { IntegrationDraft } from "./types.ts";

function draft(status: IntegrationDraft["status"]): IntegrationDraft {
  return {
    id: "drf_1",
    orgId: "acme",
    name: "Acme API",
    sourceType: null,
    status,
    specHash: null,
    baseUrl: null,
    discoveredAuth: null,
    discoveredOperations: [],
    proposedCapabilities: [],
    validationState: null,
    questions: [],
    createdBy: "user_1",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

describe("integration lifecycle", () => {
  it("allows the happy path DRAFT → … → READY", () => {
    assert.ok(canTransition("DRAFT", "DISCOVERING"));
    assert.ok(canTransition("DISCOVERING", "VALIDATING"));
    assert.ok(canTransition("VALIDATING", "REVIEW_REQUIRED"));
    assert.ok(canTransition("REVIEW_REQUIRED", "READY"));
  });

  it("rejects skipping straight from DRAFT to READY", () => {
    assert.equal(canTransition("DRAFT", "READY"), false);
  });

  it("lets a failure retry back into the pipeline", () => {
    assert.ok(canTransition("VALIDATING", "AUTH_FAILED"));
    assert.ok(canTransition("AUTH_FAILED", "AUTH_REQUIRED"));
  });

  it("treats REVOKED as terminal", () => {
    assert.equal(canTransition("REVOKED", "DRAFT"), false);
    assert.ok(canTransition("READY", "REVOKED"));
  });

  it("transitionDraft stamps updatedAt on a legal move", () => {
    const row = draft("DRAFT");
    transitionDraft(row, "DISCOVERING");
    assert.equal(row.status, "DISCOVERING");
    assert.notEqual(row.updatedAt, "2020-01-01T00:00:00.000Z");
  });

  it("transitionDraft throws on an illegal move", () => {
    const row = draft("DRAFT");
    assert.throws(() => transitionDraft(row, "READY"), /invalid integration draft transition/);
  });
});
