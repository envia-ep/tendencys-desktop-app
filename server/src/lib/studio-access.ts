import { connectorPurposeGaps, resolveToolDef } from "./registry.ts";
import { DEFAULT_JARVIS_TOOLS } from "./tools.ts";
import type { JarvisStore } from "./store.ts";
import { principalForAgent } from "./org-graph.ts";
import type { CapabilityGap, PolicyOutcome } from "./types.ts";

export function requestedToolsForAgent(store: JarvisStore, orgId: string, agentId: string): string[] {
  const requested = new Set<string>();
  for (const row of store.agentRoles.values()) {
    if (row.orgId !== orgId || row.agentId !== agentId) {
      continue;
    }
    const role = store.roles.get(row.roleId);
    for (const toolId of role?.requiredToolIds ?? []) {
      requested.add(toolId);
    }
    for (const skillLink of store.roleSkills.values()) {
      if (skillLink.roleId !== row.roleId) {
        continue;
      }
      const version = store.latestSkillVersion(skillLink.skillId);
      for (const toolId of version?.requiredTools ?? []) {
        requested.add(toolId);
      }
    }
  }
  for (const row of store.agentSkills.values()) {
    if (row.orgId !== orgId || row.agentId !== agentId) {
      continue;
    }
    const version = row.skillVersionId
      ? store.skillVersions.get(row.skillVersionId)
      : store.latestSkillVersion(row.skillId);
    for (const toolId of version?.requiredTools ?? []) {
      requested.add(toolId);
    }
  }
  return [...requested];
}

export function grantedToolsForPrincipal(store: JarvisStore, orgId: string, principalId: string): string[] {
  return [...store.accessGrants.values()]
    .filter((row) => row.orgId === orgId && row.principalId === principalId)
    .map((row) => row.toolId);
}

export function grantDefaultDesktopTools(store: JarvisStore, orgId: string, agentId: string): void {
  const principal = principalForAgent(store, orgId, agentId);
  if (!principal) {
    return;
  }
  for (const toolId of DEFAULT_JARVIS_TOOLS) {
    store.upsertAccessGrant({
      orgId,
      principalId: principal.id,
      toolId,
      kind: "can_use",
    });
  }
}

export function grantedToolsForAgent(store: JarvisStore, orgId: string, agentId: string): string[] {
  const principal = principalForAgent(store, orgId, agentId);
  if (!principal) {
    return [];
  }
  return grantedToolsForPrincipal(store, orgId, principal.id);
}

export function effectiveTools(requested: string[], granted: string[]): string[] {
  const allowed = new Set(granted);
  return requested.filter((toolId) => allowed.has(toolId));
}

export function capabilityGaps(store: JarvisStore, orgId: string): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const agent of store.listAgents(orgId)) {
    const requested = requestedToolsForAgent(store, orgId, agent.id);
    const granted = new Set(grantedToolsForAgent(store, orgId, agent.id));
    for (const toolId of requested) {
      if (!granted.has(toolId)) {
        gaps.push({
          agentId: agent.id,
          agentName: agent.name,
          toolId,
          requiredBy: "role_or_skill",
        });
      }
    }
  }
  for (const row of connectorPurposeGaps(store, orgId)) {
    gaps.push({
      agentId: "",
      agentName: "Studio",
      toolId: row.toolId,
      requiredBy: row.requiredBy,
    });
  }
  const seen = new Set<string>();
  for (const row of store.capabilities.values()) {
    if (row.orgId !== orgId || row.enabled) {
      continue;
    }
    const current = store.enabledCapability(orgId, row.toolId);
    if (!current || current.version <= row.version || seen.has(row.toolId)) {
      continue;
    }
    seen.add(row.toolId);
    gaps.push({
      agentId: "",
      agentName: "Studio",
      toolId: row.toolId,
      requiredBy: "capability_version",
    });
  }
  return gaps;
}

export function applyAutonomyPreset(
  store: JarvisStore,
  orgId: string,
  principalId: string,
  level: number,
): void {
  const clamped = Math.min(5, Math.max(1, Math.floor(level)));
  const granted = grantedToolsForPrincipal(store, orgId, principalId);
  for (const toolId of granted) {
    const def = resolveToolDef(store, orgId, toolId);
    if (!def || def.privileged || def.risk === "privileged") {
      continue;
    }
    let outcome: PolicyOutcome = "DENY";
    if (clamped >= 5) {
      outcome = "ALLOW";
    } else if (clamped >= 3) {
      outcome = def.risk === "low" ? "ALLOW" : "ALLOW_WITH_APPROVAL";
    } else if (clamped >= 2 && def.risk === "low") {
      outcome = "ALLOW_WITH_APPROVAL";
    }
    store.upsertPolicyRecord({ orgId, principalId, toolId, outcome });
  }
}
