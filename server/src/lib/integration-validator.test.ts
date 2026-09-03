import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LookupFn } from "./connectors.ts";
import { validateIntegration } from "./integration-validator.ts";
import type { ProposedCapability } from "./types.ts";

const publicLookup: LookupFn = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

function cap(over: Partial<ProposedCapability>): ProposedCapability {
  return {
    capabilityId: "acme.customers.list",
    toolId: "acme.customers.list",
    externalId: "listCustomers",
    method: "GET",
    path: "/customers",
    risk: "sensitive_read",
    confidence: 0.9,
    ...over,
  };
}

describe("integration validator", () => {
  it("passes schema/connection/auth/safe_read and registers writes unverified", async () => {
    const outcomes = await validateIntegration(
      {
        baseUrl: "https://api.acme.test",
        authKind: "bearer",
        secret: "token_123",
        operations: [cap({}), cap({ toolId: "acme.orders.refund", method: "POST", path: "/orders/refund", risk: "external_write" })],
      },
      {
        lookup: publicLookup,
        fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
      },
    );
    const byLevel = Object.fromEntries(outcomes.map((row) => [row.level, row.status]));
    assert.equal(byLevel.schema, "passed");
    assert.equal(byLevel.connection, "passed");
    assert.equal(byLevel.auth, "passed");
    assert.equal(byLevel.safe_read, "passed");
    assert.equal(byLevel.write_registered, "skipped");
    const write = outcomes.find((row) => row.level === "write_registered");
    assert.deepEqual(write?.detail.unverifiedWrites, ["acme.orders.refund"]);
  });

  it("fails auth on 401 and skips safe_read", async () => {
    const outcomes = await validateIntegration(
      {
        baseUrl: "https://api.acme.test",
        authKind: "bearer",
        secret: "bad",
        operations: [cap({})],
      },
      {
        lookup: publicLookup,
        fetch: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
      },
    );
    const byLevel = Object.fromEntries(outcomes.map((row) => [row.level, row.status]));
    assert.equal(byLevel.auth, "failed");
    assert.equal(byLevel.safe_read, "skipped");
  });

  it("fails connection for a non-https base url and skips the rest", async () => {
    const outcomes = await validateIntegration(
      { baseUrl: "http://localhost:9999", operations: [cap({})] },
      { lookup: publicLookup },
    );
    const byLevel = Object.fromEntries(outcomes.map((row) => [row.level, row.status]));
    assert.equal(byLevel.connection, "failed");
    assert.equal(byLevel.auth, "skipped");
  });

  it("fails schema when a capability has no path", async () => {
    const outcomes = await validateIntegration(
      { baseUrl: "https://api.acme.test", operations: [cap({ path: "" })] },
      { lookup: publicLookup },
    );
    assert.equal(outcomes[0]?.level, "schema");
    assert.equal(outcomes[0]?.status, "failed");
  });
});
