import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGraphView,
  createUnit,
  deleteRelationship,
  deleteUnit,
  endProject,
  replaceReportsTo,
  updateUnit,
  writeRelationship,
} from "./org-graph.ts";
import { AppError } from "./errors.ts";
import { JarvisStore } from "./store.ts";

describe("org graph write path", () => {
  it("has no independent org_edges store", () => {
    const store = new JarvisStore();
    assert.equal("orgEdges" in store, false);
  });

  it("writes reports_to through the relationship table and projects a graph view", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const me = store.ensureHumanPrincipal("acme", "user_1", "Me");
    const seeded = store.seedDefaultJarvis("acme");
    const jarvis = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    const written = writeRelationship(store, "acme", {
      kind: "reports_to",
      fromId: jarvis.id,
      toId: me.id,
    });
    assert.equal(written.status, "ok");
    const graph = buildGraphView(store, "acme");
    assert.ok(graph.nodes.some((node) => node.id === me.id && node.kind === "human"));
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.kind === "reports_to" &&
          edge.fromId === jarvis.id &&
          edge.toId === me.id &&
          edge.sourceTable === "principal_relationships",
      ),
    );
  });

  it("returns conflict for a reports_to cycle", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const a = store.ensureHumanPrincipal("acme", "user_1", "A");
    store.createAgent({
      orgId: "acme",
      name: "B",
      identity: "B",
      jobs: "B",
      toolIds: [],
      memoryPolicy: { allowScopes: ["personal"] },
      modelTier: "sol",
      grantRequestedTools: false,
    });
    const b = [...store.principals.values()].find((row) => row.displayName === "B")!;
    assert.equal(
      writeRelationship(store, "acme", { kind: "reports_to", fromId: a.id, toId: b.id }).status,
      "ok",
    );
    assert.equal(
      writeRelationship(store, "acme", { kind: "reports_to", fromId: b.id, toId: a.id }).status,
      "conflict",
    );
  });

  it("reparents to me without changing node ids", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const me = store.ensureHumanPrincipal("acme", "user_1", "Me");
    const other = store.ensureHumanPrincipal("acme", "user_2", "Other");
    const seeded = store.seedDefaultJarvis("acme");
    const jarvis = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    writeRelationship(store, "acme", { kind: "reports_to", fromId: jarvis.id, toId: other.id });
    const before = jarvis.id;
    const result = replaceReportsTo(store, "acme", jarvis.id, me.id);
    assert.equal(result.status, "ok");
    assert.equal(jarvis.id, before);
    assert.equal(me.id, store.ensureHumanPrincipal("acme", "user_1", "Me").id);
  });

  it("ending a project drops works_on but keeps home unit membership", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const me = store.ensureHumanPrincipal("acme", "user_1", "Me");
    const home = createUnit(store, { orgId: "acme", name: "Home", type: "department" });
    const project = createUnit(store, { orgId: "acme", name: "Launch", type: "project" });
    store.projectDetails.set(project.id, {
      unitId: project.id,
      startsAt: null,
      endsAt: null,
      status: "active",
      objectiveId: null,
    });
    writeRelationship(store, "acme", { kind: "member_of", fromId: me.id, toId: home.id });
    writeRelationship(store, "acme", { kind: "works_on", fromId: me.id, toId: project.id });
    endProject(store, "acme", project.id);
    assert.equal(
      [...store.unitMemberships.values()].some((row) => row.unitId === home.id && row.principalId === me.id),
      true,
    );
    assert.equal(
      [...store.projectMemberships.values()].some((row) => row.unitId === project.id),
      false,
    );
    assert.equal(store.projectDetails.get(project.id)?.status, "ended");
  });

  it("puts unit type and parent on graph node meta without parent_of edges", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const company = createUnit(store, { orgId: "acme", name: "Acme", type: "company" });
    const sales = createUnit(store, {
      orgId: "acme",
      name: "Sales",
      type: "department",
      parentUnitId: company.id,
    });
    const graph = buildGraphView(store, "acme");
    const node = graph.nodes.find((row) => row.id === sales.id);
    assert.deepEqual(node?.meta, { unitType: "department", parentUnitId: company.id });
    assert.equal(
      graph.edges.some((edge) => edge.kind === "parent_of"),
      false,
    );
  });

  it("reparents a unit and refuses a parent cycle", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const company = createUnit(store, { orgId: "acme", name: "Acme", type: "company" });
    const sales = createUnit(store, {
      orgId: "acme",
      name: "Sales",
      type: "department",
      parentUnitId: company.id,
    });
    const updated = updateUnit(store, "acme", sales.id, { name: "Revenue" });
    assert.equal(updated.name, "Revenue");
    try {
      updateUnit(store, "acme", company.id, { parentUnitId: sales.id });
      assert.fail("expected cycle");
    } catch (error) {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, "CONFLICT");
    }
  });

  it("refuses to delete a unit that still has members", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const me = store.ensureHumanPrincipal("acme", "user_1", "Me");
    const sales = createUnit(store, { orgId: "acme", name: "Sales", type: "department" });
    writeRelationship(store, "acme", { kind: "member_of", fromId: me.id, toId: sales.id });
    try {
      deleteUnit(store, "acme", sales.id);
      assert.fail("expected members conflict");
    } catch (error) {
      assert.equal((error as AppError).code, "CONFLICT");
    }
    const edge = [...store.unitMemberships.values()].find((row) => row.unitId === sales.id)!;
    assert.equal(deleteRelationship(store, "acme", edge.id), true);
    deleteUnit(store, "acme", sales.id);
    assert.equal(store.units.has(sales.id), false);
  });

  it("deletes an agent_skills row by edge id", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const created = store.createAgent({
      orgId: "acme",
      name: "CX",
      handle: "cx",
      identity: "You are CX.",
      jobs: "Support",
      toolIds: [],
      requestedToolIds: [],
      memoryPolicy: { allowScopes: ["personal", "agent", "organization", "conversation"] },
      modelTier: "sol",
    });
    const principal = store.ensureAgentPrincipal("acme", created.agent.id, "CX");
    store.skills.set("skl_1", { id: "skl_1", orgId: "acme", name: "Triage" });
    const written = writeRelationship(store, "acme", {
      kind: "has_skill",
      fromId: principal.id,
      toId: "skl_1",
    });
    assert.equal(written.status, "ok");
    assert.equal(store.agentSkills.size, 1);
    assert.equal(deleteRelationship(store, "acme", written.edgeId!), true);
    assert.equal(store.agentSkills.size, 0);
  });
});
