import { createHash } from "node:crypto";
import { id } from "./ids.ts";
import { graphChanged } from "./errors.ts";
import { buildGraphView, writeRelationship } from "./org-graph.ts";
import { compileAgentFromGraph } from "./studio-compile.ts";
import { grantDefaultDesktopTools } from "./studio-access.ts";
import type { JarvisStore } from "./store.ts";
import { handleFromName } from "./handles.ts";
import type { GraphEdge, GraphNode, StudioProposal, UnitType } from "./types.ts";

export const STUDIO_TEMPLATES = [
  "startup",
  "ecommerce",
  "saas",
  "agency",
  "real_estate",
  "restaurant",
  "professional_services",
  "law_firm",
  "healthcare",
  "custom",
] as const;

export type StudioTemplateId = (typeof STUDIO_TEMPLATES)[number];

export const ECOMMERCE_FIXTURE_BRIEF =
  "ecommerce shop with 12 people; need support, social, leads, and analytics";

type GoalModule = {
  key: string;
  unit: string;
  role: string;
  agent: string;
  skill: string;
  requiredTools: string[];
};

const GOAL_MODULES: GoalModule[] = [
  {
    key: "cx",
    unit: "Customer Experience",
    role: "CX Manager",
    agent: "CX Specialist",
    skill: "Support Triage",
    requiredTools: ["memory.recall", "notify.show"],
  },
  {
    key: "social",
    unit: "Social",
    role: "Social Manager",
    agent: "Social Specialist",
    skill: "Publish LinkedIn",
    requiredTools: ["linkedin.publish"],
  },
  {
    key: "sales",
    unit: "Sales",
    role: "Sales Manager",
    agent: "Sales Specialist",
    skill: "Lead Qualification",
    requiredTools: ["memory.remember", "memory.recall"],
  },
  {
    key: "analytics",
    unit: "Analytics",
    role: "Analytics Manager",
    agent: "Analytics Specialist",
    skill: "Reporting",
    requiredTools: ["files.read"],
  },
];

const TEMPLATE_GOALS: Record<StudioTemplateId, string[]> = {
  startup: ["cx", "sales"],
  ecommerce: ["cx", "social", "sales", "analytics"],
  saas: ["cx", "sales", "analytics"],
  agency: ["social", "sales", "analytics"],
  real_estate: ["cx", "sales"],
  restaurant: ["cx", "social"],
  professional_services: ["cx", "sales"],
  law_firm: ["cx", "sales"],
  healthcare: ["cx", "analytics"],
  custom: [],
};

export function extractBriefAttributes(brief: string): {
  templateId: StudioTemplateId;
  goals: string[];
} {
  const text = brief.toLowerCase();
  let templateId: StudioTemplateId = "custom";
  for (const name of STUDIO_TEMPLATES) {
    if (name !== "custom" && text.includes(name.replaceAll("_", " "))) {
      templateId = name;
      break;
    }
  }
  if (text.includes("ecommerce") || text.includes("e-commerce")) {
    templateId = "ecommerce";
  }
  const goals = new Set(TEMPLATE_GOALS[templateId]);
  if (/support|customer experience|\bcx\b/.test(text)) {
    goals.add("cx");
  }
  if (/social|linkedin/.test(text)) {
    goals.add("social");
  }
  if (/lead|sales/.test(text)) {
    goals.add("sales");
  }
  if (/analytics|report/.test(text)) {
    goals.add("analytics");
  }
  return { templateId, goals: [...goals] };
}

export function composeProposalGraph(
  brief: string,
  input: { templateId?: string | null; meLabel: string },
): { templateId: StudioTemplateId; nodes: GraphNode[]; edges: GraphEdge[] } {
  const extracted = extractBriefAttributes(brief);
  const templateId = isTemplate(input.templateId) ? input.templateId : extracted.templateId;
  const goals = templateId === extracted.templateId ? extracted.goals : TEMPLATE_GOALS[templateId];
  const nodes: GraphNode[] = [
    { id: "me", kind: "human", label: input.meLabel, refId: "me" },
    { id: "jarvis", kind: "agent", label: "Jarvis", refId: "jarvis" },
  ];
  const edges: GraphEdge[] = [
    {
      id: "e-jarvis-me",
      kind: "reports_to",
      fromId: "jarvis",
      toId: "me",
      sourceTable: "principal_relationships",
    },
  ];
  for (const key of goals) {
    const module = GOAL_MODULES.find((row) => row.key === key);
    if (!module) {
      continue;
    }
    nodes.push(
      { id: `unit:${key}`, kind: "unit", label: module.unit, refId: `unit:${key}` },
      { id: `role:${key}`, kind: "role", label: module.role, refId: `role:${key}` },
      { id: `agent:${key}`, kind: "agent", label: module.agent, refId: `agent:${key}` },
      { id: `skill:${key}`, kind: "skill", label: module.skill, refId: `skill:${key}` },
    );
    edges.push(
      {
        id: `e-${key}-reports`,
        kind: "reports_to",
        fromId: `agent:${key}`,
        toId: "me",
        sourceTable: "principal_relationships",
      },
      {
        id: `e-${key}-member`,
        kind: "member_of",
        fromId: `agent:${key}`,
        toId: `unit:${key}`,
        sourceTable: "unit_memberships",
      },
      {
        id: `e-${key}-role`,
        kind: "has_role",
        fromId: `agent:${key}`,
        toId: `role:${key}`,
        sourceTable: "agent_roles",
      },
      {
        id: `e-${key}-skill`,
        kind: "has_skill",
        fromId: `role:${key}`,
        toId: `skill:${key}`,
        sourceTable: "role_skills",
      },
    );
  }
  return { templateId, nodes, edges };
}

function isTemplate(value: string | null | undefined): value is StudioTemplateId {
  return Boolean(value && (STUDIO_TEMPLATES as readonly string[]).includes(value));
}

export function contentHashOf(nodes: GraphNode[], edges: GraphEdge[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ nodes, edges }))
    .digest("hex");
}

export function createStudioProposal(
  store: JarvisStore,
  input: { orgId: string; createdBy: string; brief: string; templateId?: string | null; meLabel: string },
): StudioProposal {
  const org = store.getOrg(input.orgId);
  const composed = composeProposalGraph(input.brief, {
    templateId: input.templateId,
    meLabel: input.meLabel,
  });
  const proposal: StudioProposal = {
    id: id("prp"),
    orgId: input.orgId,
    createdBy: input.createdBy,
    brief: input.brief,
    templateId: composed.templateId,
    baseGraphRevision: org?.graphRevision ?? 0,
    revision: 1,
    contentHash: contentHashOf(composed.nodes, composed.edges),
    status: "draft",
    nodes: composed.nodes,
    edges: composed.edges,
    instantiatedAt: null,
    createdAt: new Date().toISOString(),
  };
  store.studioProposals.set(proposal.id, proposal);
  return proposal;
}

export function patchStudioProposal(
  store: JarvisStore,
  proposalId: string,
  patch: { nodes?: GraphNode[]; edges?: GraphEdge[] },
): StudioProposal | undefined {
  const proposal = store.studioProposals.get(proposalId);
  if (!proposal || proposal.status === "instantiated") {
    return proposal;
  }
  if (patch.nodes) {
    proposal.nodes = patch.nodes;
  }
  if (patch.edges) {
    proposal.edges = patch.edges;
  }
  proposal.revision += 1;
  proposal.contentHash = contentHashOf(proposal.nodes, proposal.edges);
  return proposal;
}

export function instantiateProposal(
  store: JarvisStore,
  proposalId: string,
  input: { userId: string; displayName: string },
): { proposal: StudioProposal; idempotent: boolean; graph: ReturnType<typeof buildGraphView> } {
  const proposal = store.studioProposals.get(proposalId);
  if (!proposal) {
    throw new Error("Proposal not found");
  }
  const org = store.getOrg(proposal.orgId);
  if (!org) {
    throw new Error("Organization not found");
  }
  if (proposal.status === "instantiated") {
    return { proposal, idempotent: true, graph: buildGraphView(store, proposal.orgId) };
  }
  if (proposal.baseGraphRevision !== org.graphRevision) {
    throw graphChanged();
  }
  const me = store.ensureHumanPrincipal(proposal.orgId, input.userId, input.displayName);
  const idMap = new Map<string, string>([["me", me.id]]);
  store.seedDefaultJarvis(proposal.orgId);
  const jarvis = store.findAgentByName(proposal.orgId, "Jarvis")!;
  const jarvisPrincipal = store.ensureAgentPrincipal(proposal.orgId, jarvis.id, "Jarvis");
  idMap.set("jarvis", jarvisPrincipal.id);

  for (const node of proposal.nodes) {
    if (node.id === "me" || node.id === "jarvis") {
      continue;
    }
    if (node.kind === "unit") {
      const unit = {
        id: id("unt"),
        orgId: proposal.orgId,
        type: "department" as UnitType,
        name: node.label,
        parentUnitId: null,
      };
      store.units.set(unit.id, unit);
      idMap.set(node.id, unit.id);
    } else if (node.kind === "role") {
      const module = GOAL_MODULES.find((row) => node.id === `role:${row.key}`);
      const role = {
        id: id("rol"),
        orgId: proposal.orgId,
        name: node.label,
        requiredToolIds: module?.requiredTools ?? [],
      };
      store.roles.set(role.id, role);
      idMap.set(node.id, role.id);
    } else if (node.kind === "skill") {
      const module = GOAL_MODULES.find((row) => node.id === `skill:${row.key}`);
      const skill = { id: id("skl"), orgId: proposal.orgId, name: node.label };
      store.skills.set(skill.id, skill);
      const version = {
        id: id("skv"),
        skillId: skill.id,
        version: 1,
        instructions: `${node.label} v1`,
        inputSchema: {},
        outputSchema: {},
        requiredTools: module?.requiredTools ?? [],
        requiredKnowledge: [],
        evaluationPolicy: {},
      };
      store.skillVersions.set(version.id, version);
      idMap.set(node.id, skill.id);
    } else if (node.kind === "agent") {
      const created = store.createAgent({
        orgId: proposal.orgId,
        name: node.label,
        handle: node.id.startsWith("agent:") ? node.id.slice("agent:".length) : handleFromName(node.label),
        identity: `You are ${node.label}.`,
        jobs: `Serve the ${node.label} function.`,
        toolIds: [],
        requestedToolIds: [],
        memoryPolicy: {
          allowScopes: ["personal", "agent", "organization", "conversation"],
        },
        modelTier: "sol",
        grantRequestedTools: false,
      });
      const principal = store.ensureAgentPrincipal(proposal.orgId, created.agent.id, node.label);
      idMap.set(node.id, principal.id);
    } else if (node.kind === "objective") {
      const objective = {
        id: id("obj"),
        orgId: proposal.orgId,
        name: node.label,
        description: "",
        status: "open" as const,
        projectUnitId: null,
      };
      store.objectives.set(objective.id, objective);
      idMap.set(node.id, objective.id);
    }
  }

  for (const edge of proposal.edges) {
    const fromId = idMap.get(edge.fromId) ?? edge.fromId;
    const toId = idMap.get(edge.toId) ?? edge.toId;
    writeRelationship(store, proposal.orgId, { kind: edge.kind, fromId, toId }, { bumpRevision: false });
  }

  for (const agent of store.listAgents(proposal.orgId)) {
    compileAgentFromGraph(store, proposal.orgId, agent.id);
    grantDefaultDesktopTools(store, proposal.orgId, agent.id);
  }

  store.bumpGraphRevision(proposal.orgId);
  proposal.status = "instantiated";
  proposal.instantiatedAt = new Date().toISOString();
  return { proposal, idempotent: false, graph: buildGraphView(store, proposal.orgId) };
}
