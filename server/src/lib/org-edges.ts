export const EDGE_KINDS = [
  "reports_to",
  "member_of",
  "has_skill",
  "has_role",
  "works_on",
  "owns",
  "escalates_to",
  "delegates_to",
  "reviews",
  "approves",
  "collaborates_with",
  "can_use",
  "can_read",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export type GraphNodeKind =
  | "human"
  | "agent"
  | "role"
  | "unit"
  | "skill"
  | "objective"
  | "access";

export type RelationshipTable =
  | "principal_relationships"
  | "unit_memberships"
  | "agent_skills"
  | "role_skills"
  | "agent_roles"
  | "project_memberships"
  | "objective_owners"
  | "access_grants";

export type EdgeSpec = {
  from: GraphNodeKind[];
  to: GraphNodeKind[];
  table: RelationshipTable;
  acyclic?: boolean;
  noSelf?: boolean;
};

export const EDGE_REGISTRY: Record<EdgeKind, EdgeSpec> = {
  reports_to: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
    acyclic: true,
    noSelf: true,
  },
  member_of: {
    from: ["human", "agent", "role"],
    to: ["unit"],
    table: "unit_memberships",
    noSelf: true,
  },
  has_skill: {
    from: ["agent", "role"],
    to: ["skill"],
    table: "agent_skills",
  },
  has_role: {
    from: ["agent"],
    to: ["role"],
    table: "agent_roles",
  },
  works_on: {
    from: ["human", "agent"],
    to: ["unit"],
    table: "project_memberships",
  },
  owns: {
    from: ["human", "agent"],
    to: ["objective"],
    table: "objective_owners",
  },
  escalates_to: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
    noSelf: true,
  },
  delegates_to: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
    noSelf: true,
  },
  reviews: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
  },
  approves: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
  },
  collaborates_with: {
    from: ["human", "agent"],
    to: ["human", "agent"],
    table: "principal_relationships",
    noSelf: true,
  },
  can_use: {
    from: ["human", "agent"],
    to: ["access"],
    table: "access_grants",
  },
  can_read: {
    from: ["human", "agent"],
    to: ["access"],
    table: "access_grants",
  },
};

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value);
}

export function tableForEdge(kind: EdgeKind, fromKind: GraphNodeKind): RelationshipTable {
  if (kind === "has_skill" && fromKind === "role") {
    return "role_skills";
  }
  return EDGE_REGISTRY[kind].table;
}

export function validateEdgePair(
  kind: EdgeKind,
  fromKind: GraphNodeKind,
  toKind: GraphNodeKind,
  fromId: string,
  toId: string,
): { ok: true } | { ok: false; reason: string } {
  const spec = EDGE_REGISTRY[kind];
  if (!spec.from.includes(fromKind) || !spec.to.includes(toKind)) {
    return { ok: false, reason: `invalid ${kind} pair ${fromKind} → ${toKind}` };
  }
  if (spec.noSelf && fromId === toId) {
    return { ok: false, reason: `${kind} cannot target self` };
  }
  return { ok: true };
}

export function wouldCreateCycle(
  edges: Array<{ fromId: string; toId: string }>,
  fromId: string,
  toId: string,
): boolean {
  if (fromId === toId) {
    return true;
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromId) ?? [];
    list.push(edge.toId);
    outgoing.set(edge.fromId, list);
  }
  const pending = [toId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === fromId) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) {
      pending.push(next);
    }
  }
  return false;
}
