import assert from "node:assert/strict";
import {
  activityDotClass,
  activityHeartbeat,
  groupFleet,
  layoutReportingTree,
  skillsForPrincipal,
  type OrgMapEdge,
  type OrgMapNode,
} from "./jarvis-org-map.ts";

const nodes: OrgMapNode[] = [
  { id: "me", kind: "human", label: "Marcelo", refId: "user_1" },
  { id: "chief", kind: "agent", label: "Chief", refId: "agt_chief" },
  { id: "ned", kind: "agent", label: "Ned", refId: "agt_ned" },
  { id: "cx", kind: "unit", label: "Customer Experience", refId: "cx", meta: { unitType: "department" } },
  { id: "sales", kind: "unit", label: "Sales", refId: "sales", meta: { unitType: "department" } },
  { id: "role_cx", kind: "role", label: "CX lead", refId: "role_cx" },
  { id: "triage", kind: "skill", label: "Support Triage", refId: "triage" },
  { id: "leads", kind: "skill", label: "Lead Qualification", refId: "leads" },
];

const edges: OrgMapEdge[] = [
  { id: "r1", kind: "reports_to", fromId: "chief", toId: "me" },
  { id: "r2", kind: "reports_to", fromId: "ned", toId: "chief" },
  { id: "m1", kind: "member_of", fromId: "ned", toId: "cx" },
  { id: "h1", kind: "has_role", fromId: "ned", toId: "role_cx" },
  { id: "s1", kind: "has_skill", fromId: "role_cx", toId: "triage" },
  { id: "s2", kind: "has_skill", fromId: "ned", toId: "leads" },
];

const agents = [
  { id: "agt_chief", name: "Chief", handle: "chief", latestVersion: { modelTier: "sol" }, activity: { status: "idle" as const, title: null } },
  {
    id: "agt_ned",
    name: "Ned",
    handle: "ned",
    latestVersion: { modelTier: "terra", jobs: "Handle tickets" },
    activity: { status: "working" as const, title: "Reply to Carlos" },
  },
];

const fleet = groupFleet(nodes, edges, agents);
assert.equal(fleet[0]?.kind, "core");
assert.deepEqual(
  fleet[0]?.cards.map((card) => card.name),
  ["Marcelo", "Chief"],
);
assert.equal(fleet[1]?.kind, "unit");
assert.equal(fleet[1]?.title, "Customer Experience");
assert.equal(fleet[1]?.cards[0]?.role, "CX lead");
assert.equal(fleet[1]?.cards[0]?.status, "working");
assert.equal(fleet[1]?.cards[0]?.title, "Reply to Carlos");

const layout = layoutReportingTree(nodes, edges, agents);
assert.ok(layout.nodes.find((node) => node.id === "me")!.y < layout.nodes.find((node) => node.id === "ned")!.y);
assert.equal(layout.regions[0]?.label, "Customer Experience");
assert.ok(layout.nodes.some((node) => node.id === "cx" && node.kind === "unit"));
assert.ok(layout.nodes.some((node) => node.id === "sales" && node.kind === "unit"));
assert.equal(layout.connectors.find((edge) => edge.toId === "ned")?.pulse, true);
assert.equal(layout.connectors.find((edge) => edge.toId === "chief")?.pulse, false);

const waitingAgents = agents.map((agent) =>
  agent.id === "agt_chief"
    ? { ...agent, activity: { status: "waiting_for_connect" as const, title: "Review last month buyers" } }
    : agent,
);
const waitingFleet = groupFleet(nodes, edges, waitingAgents);
assert.equal(waitingFleet[0]?.cards.find((card) => card.name === "Chief")?.status, "waiting_for_connect");
assert.equal(activityHeartbeat("waiting_for_connect"), "waiting");
assert.equal(activityHeartbeat("working"), "live");
assert.equal(activityHeartbeat("idle"), "—");
assert.match(activityDotClass("waiting_for_connect"), /sky/);
assert.match(activityDotClass("working"), /emerald/);

const nedSkills = skillsForPrincipal(nodes, edges, "ned");
assert.deepEqual(
  nedSkills.map((row) => ({ skillId: row.skillId, viaRole: row.viaRole, edgeId: row.edgeId })),
  [
    { skillId: "leads", viaRole: null, edgeId: "s2" },
    { skillId: "triage", viaRole: "CX lead", edgeId: null },
  ],
);
assert.deepEqual(skillsForPrincipal(nodes, edges, "me"), []);

console.log("jarvis-org-map.test.ts OK");
