import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePolicy } from "./policy.ts";
import { JarvisStore } from "./store.ts";

describe("evaluatePolicy", () => {
  it("DENY privileged tools and never emits approval-shaped outcomes", () => {
    const store = new JarvisStore();
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["screenshots.capture"],
        tool: "screenshots.capture",
      }),
      "DENY",
    );
  });

  it("requires a temporary grant for clipboard.read", () => {
    const store = new JarvisStore();
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["clipboard.read"],
        tool: "clipboard.read",
      }),
      "ALLOW_WITH_APPROVAL",
    );
    store.upsertGrant({
      grantId: "clip_session",
      orgId: "acme",
      deviceId: "dev1",
      capability: "clipboard.read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
    assert.equal(
      evaluatePolicy({
        store,
        orgId: "acme",
        deviceId: "dev1",
        agentToolIds: ["clipboard.read"],
        tool: "clipboard.read",
        grantId: "clip_session",
      }),
      "ALLOW",
    );
  });
});
