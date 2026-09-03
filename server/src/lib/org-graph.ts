import { id } from "./ids.ts";
import {
  type EdgeKind,
  type GraphNodeKind,
  isEdgeKind,
  tableForEdge,
  validateEdgePair,
  wouldCreateCycle,
} from "./org-edges.ts";
import { conflict, notFound } from "./errors.ts";
import type { JarvisStore } from "./store.ts";
import type {
  BulkItemStatus,
  CapabilityGap,
  GraphEdge,
  GraphNode,
  OrganizationalUnit,
  Principal,
} from "./types.ts";

export type RelationshipWrite = {
  kind: string;
  fromId: string;
  toId: string;
};

export type BulkWriteResult = {
  fromId: string;
  toId: string;
  kind: string;
  status: BulkItemStatus;
  reason?: string;
  edgeId?: string;
};

export function nodeKindOf(store: JarvisStore, nodeId: string): GraphNodeKind | null {
  const principal = store.principals.get(nodeId);
  if (principal) {
    return principal.type;
  }
  if (store.units.has(nodeId)) {
    return "unit";
  }
  if (store.roles.has(nodeId)) {
    return "role";
  }
  if (store.skills.has(nodeId)) {
    return "skill";
  }
  if (store.objectives.has(nodeId)) {
    return "objective";
  }
  if (store.accessGrants.has(nodeId)) {
    return "access";
  }
  const accessByTool = [...store.accessGrants.values()].find((row) => row.toolId === nodeId);
  if (accessByTool) {
    return "access";
  }
  return null;
}

function reportsToEdges(store: JarvisStore, orgId: string) {
  return [...store.principalRelationships.values()]
    .filter((row) => row.orgId === orgId && row.kind === "reports_to")
    .map((row) => ({ fromId: row.fromPrincipalId, toId: row.toPrincipalId }));
}

export function writeRelationship(
  store: JarvisStore,
  orgId: string,
  input: RelationshipWrite,
  options?: { bumpRevision?: boolean },
): BulkWriteResult {
  if (!isEdgeKind(input.kind)) {
    return { ...input, status: "conflict", reason: "unknown edge kind" };
  }
  const kind = input.kind as EdgeKind;
  const fromKind = nodeKindOf(store, input.fromId);
  const toKind = nodeKindOf(store, input.toId);
  if (!fromKind || !toKind) {
    return { ...input, status: "not_found", reason: "missing endpoint" };
  }
  const valid = validateEdgePair(kind, fromKind, toKind, input.fromId, input.toId);
  if (!valid.ok) {
    return { ...input, status: "conflict", reason: valid.reason };
  }
  if (kind === "reports_to" && wouldCreateCycle(reportsToEdges(store, orgId), input.fromId, input.toId)) {
    return { ...input, status: "conflict", reason: "reports_to cycle" };
  }
  const table = tableForEdge(kind, fromKind);
  const edgeId = persistTypedEdge(store, orgId, kind, table, input.fromId, input.toId);
  if (options?.bumpRevision !== false) {
    store.bumpGraphRevision(orgId);
  }
  return { ...input, status: "ok", edgeId };
}

function persistTypedEdge(
  store: JarvisStore,
  orgId: string,
  kind: EdgeKind,
  table: string,
  fromId: string,
  toId: string,
): string {
  if (table === "principal_relationships") {
    const existing = [...store.principalRelationships.values()].find(
      (row) =>
        row.orgId === orgId &&
        row.kind === kind &&
        row.fromPrincipalId === fromId &&
        row.toPrincipalId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const row = {
      id: id("rel"),
      orgId,
      kind,
      fromPrincipalId: fromId,
      toPrincipalId: toId,
    };
    store.principalRelationships.set(row.id, row);
    return row.id;
  }
  if (table === "unit_memberships") {
    const existing = [...store.unitMemberships.values()].find(
      (row) => row.orgId === orgId && row.principalId === fromId && row.unitId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const row = { id: id("umb"), orgId, principalId: fromId, unitId: toId };
    store.unitMemberships.set(row.id, row);
    return row.id;
  }
  if (table === "project_memberships") {
    const existing = [...store.projectMemberships.values()].find(
      (row) => row.orgId === orgId && row.principalId === fromId && row.unitId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const row = { id: id("pmb"), orgId, principalId: fromId, unitId: toId };
    store.projectMemberships.set(row.id, row);
    return row.id;
  }
  if (table === "agent_roles") {
    const agent = store.principals.get(fromId)?.agentId;
    if (!agent) {
      throw new Error("has_role requires an agent principal");
    }
    const existing = [...store.agentRoles.values()].find(
      (row) => row.orgId === orgId && row.agentId === agent && row.roleId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const priority = [...store.agentRoles.values()].filter((row) => row.agentId === agent).length;
    const row = { id: id("arl"), orgId, agentId: agent, roleId: toId, priority };
    store.agentRoles.set(row.id, row);
    return row.id;
  }
  if (table === "agent_skills") {
    const agent = store.principals.get(fromId)?.agentId ?? fromId;
    const existing = [...store.agentSkills.values()].find(
      (row) => row.orgId === orgId && row.agentId === agent && row.skillId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const latest = store.latestSkillVersion(toId);
    const row = {
      id: id("ask"),
      orgId,
      agentId: agent,
      skillId: toId,
      skillVersionId: latest?.id ?? null,
    };
    store.agentSkills.set(row.id, row);
    return row.id;
  }
  if (table === "role_skills") {
    const existing = [...store.roleSkills.values()].find(
      (row) => row.orgId === orgId && row.roleId === fromId && row.skillId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const row = { id: id("rsk"), orgId, roleId: fromId, skillId: toId };
    store.roleSkills.set(row.id, row);
    return row.id;
  }
  if (table === "objective_owners") {
    const existing = [...store.objectiveOwners.values()].find(
      (row) => row.orgId === orgId && row.principalId === fromId && row.objectiveId === toId,
    );
    if (existing) {
      return existing.id;
    }
    const row = { id: id("owo"), orgId, principalId: fromId, objectiveId: toId };
    store.objectiveOwners.set(row.id, row);
    return row.id;
  }
  const toolId = store.accessGrants.get(toId)?.toolId ?? toId;
  const grant = store.upsertAccessGrant({
    orgId,
    principalId: fromId,
    toolId,
    kind: kind === "can_read" ? "can_read" : "can_use",
  });
  return grant.id;
}

export function replaceReportsTo(
  store: JarvisStore,
  orgId: string,
  fromPrincipalId: string,
  toPrincipalId: string,
): BulkWriteResult {
  for (const row of store.principalRelationships.values()) {
    if (row.orgId === orgId && row.kind === "reports_to" && row.fromPrincipalId === fromPrincipalId) {
      store.principalRelationships.delete(row.id);
    }
  }
  return writeRelationship(store, orgId, {
    kind: "reports_to",
    fromId: fromPrincipalId,
    toId: toPrincipalId,
  });
}

export function buildGraphView(store: JarvisStore, orgId: string): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const addNode = (node: GraphNode) => {
    if (seen.has(node.id)) {
      return;
    }
    seen.add(node.id);
    nodes.push(node);
  };

  for (const principal of store.principals.values()) {
    if (principal.orgId !== orgId) {
      continue;
    }
    addNode({
      id: principal.id,
      kind: principal.type,
      label: principal.displayName,
      refId: principal.agentId ?? principal.userId ?? principal.id,
    });
  }
  for (const unit of store.units.values()) {
    if (unit.orgId === orgId) {
      addNode({
        id: unit.id,
        kind: "unit",
        label: unit.name,
        refId: unit.id,
        meta: { unitType: unit.type, parentUnitId: unit.parentUnitId },
      });
    }
  }
  for (const role of store.roles.values()) {
    if (role.orgId === orgId) {
      addNode({ id: role.id, kind: "role", label: role.name, refId: role.id });
    }
  }
  for (const skill of store.skills.values()) {
    if (skill.orgId === orgId) {
      addNode({ id: skill.id, kind: "skill", label: skill.name, refId: skill.id });
    }
  }
  for (const objective of store.objectives.values()) {
    if (objective.orgId === orgId) {
      addNode({ id: objective.id, kind: "objective", label: objective.name, refId: objective.id });
    }
  }
  for (const grant of store.accessGrants.values()) {
    if (grant.orgId !== orgId) {
      continue;
    }
    addNode({
      id: grant.id,
      kind: "access",
      label: grant.toolId,
      refId: grant.toolId,
    });
    edges.push({
      id: grant.id,
      kind: grant.kind,
      fromId: grant.principalId,
      toId: grant.id,
      sourceTable: "access_grants",
    });
  }
  for (const row of store.principalRelationships.values()) {
    if (row.orgId === orgId) {
      edges.push({
        id: row.id,
        kind: row.kind,
        fromId: row.fromPrincipalId,
        toId: row.toPrincipalId,
        sourceTable: "principal_relationships",
      });
    }
  }
  for (const row of store.unitMemberships.values()) {
    if (row.orgId === orgId) {
      edges.push({
        id: row.id,
        kind: "member_of",
        fromId: row.principalId,
        toId: row.unitId,
        sourceTable: "unit_memberships",
      });
    }
  }
  for (const row of store.projectMemberships.values()) {
    if (row.orgId === orgId) {
      edges.push({
        id: row.id,
        kind: "works_on",
        fromId: row.principalId,
        toId: row.unitId,
        sourceTable: "project_memberships",
      });
    }
  }
  for (const row of store.agentRoles.values()) {
    if (row.orgId !== orgId) {
      continue;
    }
    const principal = principalForAgent(store, orgId, row.agentId);
    if (!principal) {
      continue;
    }
    edges.push({
      id: row.id,
      kind: "has_role",
      fromId: principal.id,
      toId: row.roleId,
      sourceTable: "agent_roles",
    });
  }
  for (const row of store.agentSkills.values()) {
    if (row.orgId !== orgId) {
      continue;
    }
    const principal = principalForAgent(store, orgId, row.agentId);
    if (!principal) {
      continue;
    }
    edges.push({
      id: row.id,
      kind: "has_skill",
      fromId: principal.id,
      toId: row.skillId,
      sourceTable: "agent_skills",
    });
  }
  for (const row of store.roleSkills.values()) {
    if (row.orgId === orgId) {
      edges.push({
        id: row.id,
        kind: "has_skill",
        fromId: row.roleId,
        toId: row.skillId,
        sourceTable: "role_skills",
      });
    }
  }
  for (const row of store.objectiveOwners.values()) {
    if (row.orgId === orgId) {
      edges.push({
        id: row.id,
        kind: "owns",
        fromId: row.principalId,
        toId: row.objectiveId,
        sourceTable: "objective_owners",
      });
    }
  }
  return { nodes, edges };
}

export function principalForAgent(
  store: JarvisStore,
  orgId: string,
  agentId: string,
): Principal | undefined {
  return [...store.principals.values()].find(
    (row) => row.orgId === orgId && row.agentId === agentId,
  );
}

export function createUnit(
  store: JarvisStore,
  input: {
    orgId: string;
    name: string;
    type: OrganizationalUnit["type"];
    parentUnitId?: string | null;
  },
): OrganizationalUnit {
  const unit: OrganizationalUnit = {
    id: id("unt"),
    orgId: input.orgId,
    type: input.type,
    name: input.name,
    parentUnitId: input.parentUnitId ?? null,
  };
  store.units.set(unit.id, unit);
  store.bumpGraphRevision(input.orgId);
  return unit;
}

export function updateUnit(
  store: JarvisStore,
  orgId: string,
  unitId: string,
  patch: { name?: string; parentUnitId?: string | null },
): OrganizationalUnit {
  const unit = store.units.get(unitId);
  if (!unit || unit.orgId !== orgId) {
    throw notFound("Unit");
  }
  if (patch.name !== undefined) {
    unit.name = patch.name;
  }
  if (patch.parentUnitId !== undefined) {
    if (patch.parentUnitId === unit.id) {
      throw conflict("Unit cannot parent itself");
    }
    if (patch.parentUnitId) {
      const parent = store.units.get(patch.parentUnitId);
      if (!parent || parent.orgId !== orgId) {
        throw notFound("Parent unit");
      }
      let cursor: string | null = parent.parentUnitId;
      while (cursor) {
        if (cursor === unit.id) {
          throw conflict("Unit parent cycle");
        }
        cursor = store.units.get(cursor)?.parentUnitId ?? null;
      }
    }
    unit.parentUnitId = patch.parentUnitId;
  }
  store.bumpGraphRevision(orgId);
  return unit;
}

export function deleteUnit(store: JarvisStore, orgId: string, unitId: string): void {
  const unit = store.units.get(unitId);
  if (!unit || unit.orgId !== orgId) {
    throw notFound("Unit");
  }
  const hasChild = [...store.units.values()].some(
    (row) => row.orgId === orgId && row.parentUnitId === unitId,
  );
  if (hasChild) {
    throw conflict("Unit has child units");
  }
  const hasMember = [...store.unitMemberships.values()].some(
    (row) => row.orgId === orgId && row.unitId === unitId,
  );
  if (hasMember) {
    throw conflict("Unit has members");
  }
  store.units.delete(unitId);
  store.projectDetails.delete(unitId);
  store.bumpGraphRevision(orgId);
}

export function deleteRelationship(
  store: JarvisStore,
  orgId: string,
  edgeId: string,
): boolean {
  const rel = store.principalRelationships.get(edgeId);
  if (rel && rel.orgId === orgId) {
    store.principalRelationships.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  const membership = store.unitMemberships.get(edgeId);
  if (membership && membership.orgId === orgId) {
    store.unitMemberships.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  const project = store.projectMemberships.get(edgeId);
  if (project && project.orgId === orgId) {
    store.projectMemberships.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  const agentSkill = store.agentSkills.get(edgeId);
  if (agentSkill && agentSkill.orgId === orgId) {
    store.agentSkills.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  const roleSkill = store.roleSkills.get(edgeId);
  if (roleSkill && roleSkill.orgId === orgId) {
    store.roleSkills.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  const agentRole = store.agentRoles.get(edgeId);
  if (agentRole && agentRole.orgId === orgId) {
    store.agentRoles.delete(edgeId);
    store.bumpGraphRevision(orgId);
    return true;
  }
  return false;
}

export function endProject(store: JarvisStore, orgId: string, unitId: string): void {
  for (const row of store.projectMemberships.values()) {
    if (row.orgId === orgId && row.unitId === unitId) {
      store.projectMemberships.delete(row.id);
    }
  }
  const details = store.projectDetails.get(unitId);
  if (details) {
    details.status = "ended";
  }
  store.bumpGraphRevision(orgId);
}
