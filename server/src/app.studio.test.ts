import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { generateEd25519, signBytes } from "./lib/crypto.ts";
import { loadEnv } from "./lib/env.ts";
import { ECOMMERCE_FIXTURE_BRIEF } from "./lib/studio-propose.ts";
import { JarvisStore } from "./lib/store.ts";

function attest(device: ReturnType<typeof generateEd25519>, deviceId: string) {
  return signBytes(device.privateKeyB64, Buffer.from(`${deviceId}|${device.publicKeyB64}`));
}

async function boot() {
  const store = new JarvisStore();
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
  const app = createApp({ store, env });
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
  const sessionJson = (await sessionRes.json()) as {
    success: true;
    data: { token: string };
  };
  return {
    store,
    app,
    auth: { Authorization: `Bearer ${sessionJson.data.token}` },
  };
}

describe("studio HTTP", () => {
  it("returns a graph view with a human principal and no org_edges map", async () => {
    const { store, app, auth } = await boot();
    const res = await app.request("/api/v1/studio", { headers: auth });
    const json = (await res.json()) as {
      success: true;
      data: { nodes: Array<{ kind: string }>; gaps: unknown[] };
    };
    assert.equal(res.status, 200);
    assert.ok(json.data.nodes.some((node) => node.kind === "human"));
    assert.equal("orgEdges" in store, false);
  });

  it("instantiates an ecommerce proposal and surfaces required-vs-granted gaps", async () => {
    const { app, auth } = await boot();
    const created = await app.request("/api/v1/studio/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ brief: ECOMMERCE_FIXTURE_BRIEF }),
    });
    assert.equal(created.status, 201);
    const proposal = (await created.json()) as { data: { proposal: { id: string } } };
    const inst = await app.request(`/api/v1/studio/proposals/${proposal.data.proposal.id}/instantiate`, {
      method: "POST",
      headers: auth,
    });
    const body = (await inst.json()) as {
      success: true;
      data: { gaps: Array<{ toolId: string }>; idempotent: boolean };
    };
    assert.equal(inst.status, 200, JSON.stringify(body));
    assert.equal(body.data.idempotent, false);
    assert.ok(body.data.gaps.some((gap) => gap.toolId === "linkedin.publish"));
    const replay = await app.request(`/api/v1/studio/proposals/${proposal.data.proposal.id}/instantiate`, {
      method: "POST",
      headers: auth,
    });
    const replayed = (await replay.json()) as { data: { idempotent: boolean } };
    assert.equal(replayed.data.idempotent, true);
  });

  it("stores workflows as draft jsonb only", async () => {
    const { store, app, auth } = await boot();
    const res = await app.request("/api/v1/studio/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        name: "Weekly recap",
        definition: { steps: [{ say: "hello" }] },
      }),
    });
    assert.equal(res.status, 201);
    const workflow = [...store.workflows.values()][0];
    assert.equal(workflow.status, "draft");
    assert.deepEqual(workflow.definition, { steps: [{ say: "hello" }] });
    assert.equal("nextRunAt" in workflow, false);
  });

  it("patches a unit parent and refuses deleting a unit with members", async () => {
    const { app, auth } = await boot();
    const created = await app.request("/api/v1/studio/units", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        items: [
          { name: "Acme", type: "company" },
          { name: "Sales", type: "department" },
        ],
      }),
    });
    const createdBody = (await created.json()) as { data: { results: Array<{ id: string }> } };
    const companyId = createdBody.data.results[0].id;
    const salesId = createdBody.data.results[1].id;
    const patched = await app.request(`/api/v1/studio/units/${salesId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ parentUnitId: companyId }),
    });
    const patchBody = (await patched.json()) as {
      data: { graph: { nodes: Array<{ id: string; meta?: { parentUnitId?: string | null } }> } };
    };
    assert.equal(patched.status, 200);
    assert.equal(
      patchBody.data.graph.nodes.find((node) => node.id === salesId)?.meta?.parentUnitId,
      companyId,
    );
    const studio = await app.request("/api/v1/studio", { headers: auth });
    const snapshot = (await studio.json()) as {
      data: { nodes: Array<{ id: string; kind: string }> };
    };
    const me = snapshot.data.nodes.find((node) => node.kind === "human")!;
    await app.request("/api/v1/studio/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ items: [{ kind: "member_of", fromId: me.id, toId: salesId }] }),
    });
    const blocked = await app.request(`/api/v1/studio/units/${salesId}`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(blocked.status, 409);
  });

  it("replaces reports_to on the live graph", async () => {
    const { store, app, auth } = await boot();
    const studio = await app.request("/api/v1/studio", { headers: auth });
    const snapshot = (await studio.json()) as {
      data: { nodes: Array<{ id: string; kind: string }> };
    };
    const me = snapshot.data.nodes.find((node) => node.kind === "human")!;
    const jarvis = snapshot.data.nodes.find((node) => node.kind === "agent")!;
    const other = store.ensureHumanPrincipal("org_acme", "user_2", "Other");
    const replaced = await app.request("/api/v1/studio/relationships/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ kind: "reports_to", fromId: jarvis.id, toId: other.id }),
    });
    const body = (await replaced.json()) as {
      data: { graph: { edges: Array<{ kind: string; fromId: string; toId: string }> } };
    };
    assert.equal(replaced.status, 200);
    assert.ok(
      body.data.graph.edges.some(
        (edge) => edge.kind === "reports_to" && edge.fromId === jarvis.id && edge.toId === other.id,
      ),
    );
    const back = await app.request("/api/v1/studio/relationships/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ kind: "reports_to", fromId: jarvis.id, toId: me.id }),
    });
    assert.equal(back.status, 200);
  });
});
