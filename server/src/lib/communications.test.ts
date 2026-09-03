import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../app.ts";
import { generateEd25519, signBytes } from "./crypto.ts";
import { loadEnv } from "./env.ts";
import { JarvisStore } from "./store.ts";
import { createTaskRecord, memoryWorkforce } from "./workforce.ts";

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

describe("communications feed", () => {
  it("projects h_a, a_h, and a_a with from and to", async () => {
    const store = new JarvisStore();
    const workforce = memoryWorkforce();
    const server = generateEd25519();
    const device = generateEd25519();
    const env = loadEnv({
      jwtSecret: "test-jarvis-jwt-secret-min-32-chars!!",
      serverPrivateKeyB64: server.privateKeyB64,
      serverPublicKeyB64: server.publicKeyB64,
      leaseMs: 30_000,
      modelApiKey: null,
      supabaseUrl: null,
      supabaseServiceRoleKey: null,
    });
    const app = createApp({ store, env, workforce });
    const deviceId = "dev_macbook";
    const sessionRes = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atid: "test:user_1:org_acme",
        deviceId,
        devicePublicKey: device.publicKeyB64,
        attestation: attest(device, deviceId),
        deviceName: "MacBook",
      }),
    });
    const session = (await sessionRes.json()) as { data: { token: string } };
    const auth = { Authorization: `Bearer ${session.data.token}` };

    const seeded = store.seedDefaultJarvis("org_acme");
    const human = store.ensureHumanPrincipal("org_acme", "user_1", "Me");
    const sales = store.createAgent({
      orgId: "org_acme",
      name: "Sales",
      identity: "You are Sales.",
      jobs: "Qualify leads.",
      toolIds: ["memory.recall"],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
    });
    const salesPrincipal = store.ensureAgentPrincipal("org_acme", sales.agent.id, "Sales");
    const jarvisPrincipal = store.ensureAgentPrincipal("org_acme", seeded.agent.id, "Jarvis");
    const thread = store.createThread({
      orgId: "org_acme",
      actorId: "user_1",
      agentId: seeded.agent.id,
    });
    store.addMessage(thread.id, "user", "Need a follow-up on inbound leads");
    store.addMessage(thread.id, "assistant", "I will assign Sales.");
    await createTaskRecord(
      store,
      workforce,
      {
        orgId: "org_acme",
        name: "Qualify inbound leads",
        assigneePrincipalId: salesPrincipal.id,
        createdByPrincipalId: jarvisPrincipal.id,
      },
      { orgId: "org_acme", userId: "user_1", sessionId: "ses_1", deviceId },
    );

    const res = await app.request("/api/v1/communications", { headers: auth });
    const body = (await res.json()) as {
      success: true;
      data: {
        items: Array<{
          kind: string;
          from: { id: string | null; type: string };
          to: { id: string | null; type: string };
          content: string;
        }>;
      };
    };
    assert.equal(res.status, 200);
    const kinds = body.data.items.map((item) => item.kind);
    assert.ok(kinds.includes("h_a"));
    assert.ok(kinds.includes("a_h"));
    assert.ok(kinds.includes("a_a"));
    const humanToAgent = body.data.items.find((item) => item.kind === "h_a");
    const agentToHuman = body.data.items.find((item) => item.kind === "a_h");
    const agentToAgent = body.data.items.find((item) => item.kind === "a_a");
    assert.equal(humanToAgent?.from.type, "human");
    assert.equal(humanToAgent?.to.id, seeded.agent.id);
    assert.equal(agentToHuman?.from.id, seeded.agent.id);
    assert.equal(agentToHuman?.to.type, "human");
    assert.equal(agentToAgent?.from.id, seeded.agent.id);
    assert.equal(agentToAgent?.to.id, sales.agent.id);
    assert.equal(agentToAgent?.content, "Qualify inbound leads");
    assert.equal(human?.type, "human");

    store.addMemory({
      id: "mem_spanish",
      orgId: "org_acme",
      scopeType: "personal",
      scopeId: null,
      subjectUserId: "user_1",
      createdByAgentId: seeded.agent.id,
      source: "explicit",
      content: "I prefer Spanish invoices",
      importance: 0.6,
      confidence: 1,
      sensitivity: "normal",
      embedding: [],
      createdAt: new Date().toISOString(),
      lastConfirmedAt: null,
      expiresAt: null,
    });
    const afterMemory = await app.request("/api/v1/communications", { headers: auth });
    const afterBody = (await afterMemory.json()) as typeof body;
    assert.equal(afterMemory.status, 200);
    assert.equal(
      afterBody.data.items.some((item) => item.content.includes("Spanish invoices")),
      false,
    );
  });
});
