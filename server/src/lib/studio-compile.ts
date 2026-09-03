import { grantDefaultDesktopTools, requestedToolsForAgent } from "./studio-access.ts";
import type { JarvisStore } from "./store.ts";
import { DEFAULT_JARVIS_TOOLS } from "./tools.ts";
import type { AgentVersion } from "./types.ts";

export function ensureDefaultDesktopTools(store: JarvisStore, orgId: string): void {
  for (const agent of store.listAgents(orgId)) {
    grantDefaultDesktopTools(store, orgId, agent.id);
    const version = store.latestVersion(agent.id);
    const requested = version?.requestedToolIds ?? [];
    if (!DEFAULT_JARVIS_TOOLS.every((toolId) => requested.includes(toolId))) {
      compileAgentFromGraph(store, orgId, agent.id);
    }
  }
}

export function compileAgentFromGraph(
  store: JarvisStore,
  orgId: string,
  agentId: string,
): AgentVersion | undefined {
  const agent = store.agents.get(agentId);
  if (!agent || agent.orgId !== orgId) {
    return undefined;
  }
  const latest = store.latestVersion(agentId);
  const roleIds = [...store.agentRoles.values()]
    .filter((row) => row.orgId === orgId && row.agentId === agentId)
    .sort((a, b) => a.priority - b.priority)
    .map((row) => row.roleId);
  const skillVersionIds: string[] = [];
  for (const row of store.agentSkills.values()) {
    if (row.orgId !== orgId || row.agentId !== agentId) {
      continue;
    }
    const pinned = row.skillVersionId ?? store.latestSkillVersion(row.skillId)?.id;
    if (pinned) {
      skillVersionIds.push(pinned);
    }
  }
  for (const roleId of roleIds) {
    for (const link of store.roleSkills.values()) {
      if (link.roleId !== roleId) {
        continue;
      }
      const version = store.latestSkillVersion(link.skillId);
      if (version) {
        skillVersionIds.push(version.id);
      }
    }
  }
  const uniqueSkillVersions = [...new Set(skillVersionIds)];
  const responsibilities = roleIds.flatMap((roleId) =>
    [...store.roleResponsibilities.values()]
      .filter((row) => row.roleId === roleId)
      .map((row) => row.text),
  );
  const compiledRequested = requestedToolsForAgent(store, orgId, agentId);
  const baseRequested =
    compiledRequested.length > 0
      ? compiledRequested
      : (latest?.requestedToolIds ?? latest?.toolIds ?? []);
  const requestedToolIds = [...new Set([...DEFAULT_JARVIS_TOOLS, ...baseRequested])];
  const roleNames = roleIds.map((roleId) => store.roles.get(roleId)?.name).filter(Boolean);
  const identity = latest?.identity ?? `You are ${agent.name}.`;
  const jobs = roleNames.length > 0 ? roleNames.join(", ") : (latest?.jobs ?? agent.name);
  return store.addAgentVersion(agentId, {
    identity,
    jobs,
    toolIds: requestedToolIds,
    requestedToolIds,
    roleIds,
    skillVersionIds: uniqueSkillVersions,
    compiledInstructions: [identity, jobs, ...responsibilities].join("\n"),
    responsibilities,
    expectedOutcomes: [],
    memoryPolicy: latest?.memoryPolicy ?? {
      allowScopes: ["personal", "agent", "organization", "conversation"],
    },
    modelTier: latest?.modelTier ?? "sol",
  });
}

export function compileAgentsTouchedBySkillEdge(
  store: JarvisStore,
  orgId: string,
  fromId: string,
): void {
  const principal = store.principals.get(fromId);
  if (principal?.agentId) {
    compileAgentFromGraph(store, orgId, principal.agentId);
    return;
  }
  for (const row of store.agentRoles.values()) {
    if (row.orgId === orgId && row.roleId === fromId) {
      compileAgentFromGraph(store, orgId, row.agentId);
    }
  }
}
