import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectorHealthLookup,
  getConnectorHealth,
  healthStateForError,
  recordConnectorHealth,
} from "./connector-health.ts";
import { JarvisStore } from "./store.ts";

describe("connector health", () => {
  it("records and reads back the latest state per connector", () => {
    const store = new JarvisStore();
    recordConnectorHealth(store, { orgId: "org", connectorId: "conn", state: "READY" });
    recordConnectorHealth(store, { orgId: "org", connectorId: "conn", state: "AUTH_EXPIRED", detail: "401" });
    const row = getConnectorHealth(store, "conn");
    assert.equal(row?.state, "AUTH_EXPIRED");
    assert.equal(row?.detail, "401");
    assert.equal(store.healthFor("org").length, 1);
  });

  it("exposes a resolver lookup", () => {
    const store = new JarvisStore();
    recordConnectorHealth(store, { orgId: "org", connectorId: "conn", state: "DEGRADED" });
    const lookup = connectorHealthLookup(store);
    assert.equal(lookup("conn")?.state, "DEGRADED");
    assert.equal(lookup("missing"), undefined);
  });

  it("maps runtime errors to health states", () => {
    assert.equal(healthStateForError("egress_denied"), "UNREACHABLE");
    assert.equal(healthStateForError("fetch failed"), "UNREACHABLE");
    assert.equal(healthStateForError("HTTP 401 unauthorized"), "AUTH_EXPIRED");
    assert.equal(healthStateForError("token expired"), "AUTH_EXPIRED");
    assert.equal(healthStateForError("HTTP 500 boom"), "DEGRADED");
    assert.equal(healthStateForError("connector_missing"), null);
    assert.equal(healthStateForError("capability_missing"), null);
  });
});
