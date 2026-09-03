export type OrgMapNode = {
  id: string;
  kind: string;
  label: string;
  refId: string;
  meta?: { unitType?: string; parentUnitId?: string | null };
};

export type OrgMapEdge = {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
};

export type AgentActivity = {
  status:
    | "idle"
    | "starting"
    | "working"
    | "waiting_for_local_tool"
    | "waiting_for_approval"
    | "waiting_for_connect";
  title: string | null;
};

export function activityDotClass(status: AgentActivity["status"]): string {
  if (status === "working") {
    return "bg-emerald-400 shadow-[0_0_10px_#34d399]";
  }
  if (status === "starting") {
    return "bg-amber-300";
  }
  if (status === "waiting_for_connect") {
    return "bg-sky-400";
  }
  if (status === "waiting_for_approval") {
    return "bg-amber-400";
  }
  if (status === "waiting_for_local_tool") {
    return "bg-violet-400";
  }
  return "bg-white/25";
}

export function activityHeartbeat(status: AgentActivity["status"]): "live" | "waiting" | "—" {
  if (status === "working") {
    return "live";
  }
  if (
    status === "waiting_for_connect" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_local_tool"
  ) {
    return "waiting";
  }
  return "—";
}

export type FleetAgent = {
  id: string;
  name: string;
  handle: string;
  latestVersion?: { modelTier?: string; jobs?: string };
  activity?: AgentActivity;
};

export type FleetCard = {
  nodeId: string;
  agentId: string | null;
  name: string;
  handle: string | null;
  role: string;
  status: AgentActivity["status"];
  title: string | null;
  model: string | null;
};

export type FleetSection = {
  id: string;
  title: string;
  kind: "core" | "unit" | "unassigned";
  cards: FleetCard[];
};

export type OrgMapPlacedNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  kind: string;
  refId: string;
  role: string;
  status: AgentActivity["status"];
  title: string | null;
};

export type OrgMapRegion = {
  unitId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
};

export type OrgMapConnector = {
  id: string;
  fromId: string;
  toId: string;
  d: string;
  pulse: boolean;
};

export type OrgMapLayout = {
  width: number;
  height: number;
  nodes: OrgMapPlacedNode[];
  regions: OrgMapRegion[];
  connectors: OrgMapConnector[];
};

const NODE_W = 180;
const NODE_H = 78;
const H_GAP = 36;
const V_GAP = 96;
const REGION_PAD = 28;
const UNIT_COLORS = ["#3d8bfd", "#68AE34", "#c084fc", "#f59e0b", "#22d3ee", "#fb7185"];

function peopleOf(nodes: OrgMapNode[]) {
  return nodes.filter((node) => node.kind === "human" || node.kind === "agent");
}

function reportsChildren(edges: OrgMapEdge[]) {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "reports_to") {
      continue;
    }
    const list = children.get(edge.toId) ?? [];
    list.push(edge.fromId);
    children.set(edge.toId, list);
  }
  return children;
}

function reportsDepth(nodes: OrgMapNode[], edges: OrgMapEdge[]) {
  const people = peopleOf(nodes);
  const ids = new Set(people.map((node) => node.id));
  const children = reportsChildren(edges);
  const roots = people.filter((node) => !edges.some((edge) => edge.kind === "reports_to" && edge.fromId === node.id));
  const depth = new Map<string, number>();
  const walk = (id: string, level: number) => {
    if (!ids.has(id) || depth.has(id)) {
      return;
    }
    depth.set(id, level);
    for (const child of children.get(id) ?? []) {
      walk(child, level + 1);
    }
  };
  for (const root of roots) {
    walk(root.id, 0);
  }
  for (const person of people) {
    if (!depth.has(person.id)) {
      depth.set(person.id, 0);
    }
  }
  return { depth, roots, children };
}

function firstMembership(nodeId: string, edges: OrgMapEdge[]) {
  return edges.find((edge) => edge.kind === "member_of" && edge.fromId === nodeId)?.toId ?? null;
}

function roleLabel(node: OrgMapNode, edges: OrgMapEdge[], nodes: OrgMapNode[], agent?: FleetAgent) {
  const roleId = edges.find((edge) => edge.kind === "has_role" && edge.fromId === node.id)?.toId;
  const role = roleId ? nodes.find((item) => item.id === roleId) : undefined;
  if (role?.label) {
    return role.label;
  }
  const jobs = agent?.latestVersion?.jobs?.trim();
  if (jobs) {
    return jobs.slice(0, 48);
  }
  return agent?.handle ? `@${agent.handle}` : node.kind;
}

function toCard(node: OrgMapNode, edges: OrgMapEdge[], nodes: OrgMapNode[], agents: FleetAgent[]): FleetCard {
  const agent = node.kind === "agent" ? agents.find((item) => item.id === node.refId) : undefined;
  return {
    nodeId: node.id,
    agentId: agent?.id ?? null,
    name: node.label,
    handle: agent?.handle ?? null,
    role: roleLabel(node, edges, nodes, agent),
    status: agent?.activity?.status ?? "idle",
    title: agent?.activity?.status === "idle" ? null : (agent?.activity?.title ?? null),
    model: agent?.latestVersion?.modelTier ?? null,
  };
}

export function groupFleet(nodes: OrgMapNode[], edges: OrgMapEdge[], agents: FleetAgent[]): FleetSection[] {
  const people = peopleOf(nodes);
  const { depth } = reportsDepth(nodes, edges);
  const used = new Set<string>();
  const sections: FleetSection[] = [];
  const core = people
    .filter((node) => (depth.get(node.id) ?? 99) <= 1)
    .map((node) => {
      used.add(node.id);
      return toCard(node, edges, nodes, agents);
    });
  if (core.length > 0) {
    sections.push({ id: "core", title: "Core", kind: "core", cards: core });
  }
  const byUnit = new Map<string, FleetCard[]>();
  const unassigned: FleetCard[] = [];
  for (const person of people) {
    if (used.has(person.id)) {
      continue;
    }
    const unitId = firstMembership(person.id, edges);
    const card = toCard(person, edges, nodes, agents);
    if (!unitId) {
      unassigned.push(card);
      continue;
    }
    const list = byUnit.get(unitId) ?? [];
    list.push(card);
    byUnit.set(unitId, list);
  }
  for (const [unitId, cards] of byUnit) {
    const unit = nodes.find((node) => node.id === unitId);
    sections.push({
      id: unitId,
      title: unit?.label ?? unitId,
      kind: "unit",
      cards,
    });
  }
  if (unassigned.length > 0) {
    sections.push({ id: "unassigned", title: "Unassigned", kind: "unassigned", cards: unassigned });
  }
  return sections;
}

function subtreeWidth(id: string, children: Map<string, string[]>, seen: Set<string>): number {
  if (seen.has(id)) {
    return NODE_W;
  }
  seen.add(id);
  const kids = children.get(id) ?? [];
  if (kids.length === 0) {
    return NODE_W;
  }
  return Math.max(
    NODE_W,
    kids.reduce((sum, child) => sum + subtreeWidth(child, children, seen), 0) + H_GAP * (kids.length - 1),
  );
}

function cubic(from: OrgMapPlacedNode, to: OrgMapPlacedNode): string {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

export function layoutReportingTree(
  nodes: OrgMapNode[],
  edges: OrgMapEdge[],
  agents: FleetAgent[] = [],
): OrgMapLayout {
  const people = peopleOf(nodes);
  const { roots, children } = reportsDepth(nodes, edges);
  const placed: OrgMapPlacedNode[] = [];
  const place = (id: string, x: number, y: number, seen: Set<string>) => {
    const node = people.find((item) => item.id === id);
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    const agent = node.kind === "agent" ? agents.find((item) => item.id === node.refId) : undefined;
    placed.push({
      id: node.id,
      x,
      y,
      width: NODE_W,
      height: NODE_H,
      label: node.label,
      kind: node.kind,
      refId: node.refId,
      role: roleLabel(node, edges, nodes, agent),
      status: agent?.activity?.status ?? "idle",
      title: agent?.activity?.status === "idle" ? null : (agent?.activity?.title ?? null),
    });
    const kids = (children.get(id) ?? []).filter((child) => people.some((item) => item.id === child));
    const widths = kids.map((child) => subtreeWidth(child, children, new Set(seen)));
    const total = widths.reduce((sum, width) => sum + width, 0) + H_GAP * Math.max(0, kids.length - 1);
    let cursor = x + NODE_W / 2 - total / 2;
    kids.forEach((child, index) => {
      const width = widths[index] ?? NODE_W;
      place(child, cursor + width / 2 - NODE_W / 2, y + NODE_H + V_GAP, seen);
      cursor += width + H_GAP;
    });
  };
  const units = nodes.filter((node) => node.kind === "unit");
  let unitOrigin = REGION_PAD + 40;
  for (const unit of units) {
    placed.push({
      id: unit.id,
      x: unitOrigin,
      y: REGION_PAD,
      width: NODE_W,
      height: NODE_H,
      label: unit.label,
      kind: "unit",
      refId: unit.refId,
      role: unit.meta?.unitType ?? "unit",
      status: "idle",
      title: null,
    });
    unitOrigin += NODE_W + H_GAP;
  }
  const peopleTop = units.length > 0 ? REGION_PAD + NODE_H + V_GAP : REGION_PAD + 36;
  const forest = roots.length > 0 ? roots : people;
  const seen = new Set<string>();
  let origin = REGION_PAD + 40;
  for (const root of forest) {
    const width = subtreeWidth(root.id, children, new Set());
    place(root.id, origin + width / 2 - NODE_W / 2, peopleTop, seen);
    origin += width + H_GAP * 2;
  }
  for (const person of people) {
    if (!seen.has(person.id)) {
      place(person.id, origin, peopleTop, seen);
      origin += NODE_W + H_GAP;
    }
  }

  const byId = new Map(placed.map((node) => [node.id, node]));
  const connectors: OrgMapConnector[] = [];
  for (const edge of edges) {
    if (edge.kind !== "reports_to") {
      continue;
    }
    const manager = byId.get(edge.toId);
    const report = byId.get(edge.fromId);
    if (!manager || !report) {
      continue;
    }
    connectors.push({
      id: edge.id,
      fromId: manager.id,
      toId: report.id,
      d: cubic(manager, report),
      pulse: report.status === "working",
    });
  }

  const regions: OrgMapRegion[] = [];
  const unitIds = [...new Set(people.map((node) => firstMembership(node.id, edges)).filter(Boolean))] as string[];
  unitIds.forEach((unitId, index) => {
    const members = people
      .filter((node) => firstMembership(node.id, edges) === unitId)
      .map((node) => byId.get(node.id))
      .filter((node): node is OrgMapPlacedNode => Boolean(node));
    if (members.length === 0) {
      return;
    }
    const left = Math.min(...members.map((node) => node.x)) - REGION_PAD;
    const top = Math.min(...members.map((node) => node.y)) - REGION_PAD;
    const right = Math.max(...members.map((node) => node.x + node.width)) + REGION_PAD;
    const bottom = Math.max(...members.map((node) => node.y + node.height)) + REGION_PAD;
    const unit = nodes.find((node) => node.id === unitId);
    regions.push({
      unitId,
      label: unit?.label ?? unitId,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      color: UNIT_COLORS[index % UNIT_COLORS.length] ?? UNIT_COLORS[0],
    });
  });

  const boxes = [...placed, ...regions];
  const width = boxes.length === 0 ? 480 : Math.max(...boxes.map((box) => box.x + box.width)) + 48;
  const height = boxes.length === 0 ? 320 : Math.max(...boxes.map((box) => box.y + box.height)) + 48;
  return { width, height, nodes: placed, regions, connectors };
}

export type PrincipalSkill = {
  skillId: string;
  name: string;
  edgeId: string | null;
  viaRole: string | null;
};

export function skillsForPrincipal(
  nodes: OrgMapNode[],
  edges: OrgMapEdge[],
  principalId: string,
): PrincipalSkill[] {
  const selected = nodes.find((node) => node.id === principalId);
  if (!selected || selected.kind !== "agent") {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const listed: PrincipalSkill[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "has_skill" || edge.fromId !== principalId) {
      continue;
    }
    const skill = byId.get(edge.toId);
    if (!skill || skill.kind !== "skill") {
      continue;
    }
    seen.add(skill.id);
    listed.push({ skillId: skill.id, name: skill.label, edgeId: edge.id, viaRole: null });
  }
  const roleIds = edges
    .filter((edge) => edge.kind === "has_role" && edge.fromId === principalId)
    .map((edge) => edge.toId);
  for (const roleId of roleIds) {
    const role = byId.get(roleId);
    for (const edge of edges) {
      if (edge.kind !== "has_skill" || edge.fromId !== roleId || seen.has(edge.toId)) {
        continue;
      }
      const skill = byId.get(edge.toId);
      if (!skill || skill.kind !== "skill") {
        continue;
      }
      seen.add(skill.id);
      listed.push({
        skillId: skill.id,
        name: skill.label,
        edgeId: null,
        viaRole: role?.label ?? roleId,
      });
    }
  }
  return listed;
}
