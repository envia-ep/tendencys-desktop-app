import type { JarvisStore } from "./store.ts";
import { requestedToolsForAgent } from "./studio-access.ts";
import { TOOLS, type ToolDef } from "./tools.ts";
import type { CustomTool, ToolRisk } from "./types.ts";

const RISK_RANK: Record<ToolRisk, number> = {
  low: 0,
  sensitive_read: 1,
  external_write: 2,
  destructive: 3,
  privileged: 4,
};

export function maxRisk(risks: ToolRisk[]): ToolRisk {
  return risks.reduce<ToolRisk>((highest, risk) => {
    return RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest;
  }, "low");
}

export function isFirstPartyTool(toolId: string): boolean {
  return Boolean(TOOLS[toolId]);
}

export function enabledRegistryToolIds(store: JarvisStore, orgId: string): string[] {
  const ids = new Set<string>();
  for (const row of store.capabilities.values()) {
    if (row.orgId === orgId && row.enabled) {
      ids.add(row.toolId);
    }
  }
  for (const row of store.customTools.values()) {
    if (row.orgId === orgId) {
      ids.add(row.toolId);
    }
  }
  return [...ids];
}

export function inheritCustomRisk(store: JarvisStore, orgId: string, custom: CustomTool): ToolRisk {
  const risks = custom.definition.steps.map((step) => {
    const cap = [...store.capabilities.values()].find(
      (row) =>
        row.orgId === orgId &&
        row.toolId === step.toolId &&
        row.version === step.version,
    );
    return cap?.risk ?? "low";
  });
  return maxRisk(risks);
}

export function resolveToolDef(
  store: JarvisStore,
  orgId: string,
  toolId: string,
): ToolDef | undefined {
  const first = TOOLS[toolId];
  if (first) {
    return first;
  }
  const custom = store.customToolById(orgId, toolId);
  if (custom) {
    return {
      id: custom.toolId,
      side: "cloud",
      risk: inheritCustomRisk(store, orgId, custom),
    };
  }
  const capability = store.enabledCapability(orgId, toolId);
  if (capability) {
    return {
      id: capability.toolId,
      side: capability.side,
      risk: capability.risk,
      privileged: capability.risk === "privileged",
    };
  }
  return undefined;
}

export function presentedRegistryTools(
  store: JarvisStore,
  orgId: string,
  granted: string[],
): string[] {
  const allowed = new Set(granted);
  return enabledRegistryToolIds(store, orgId).filter((toolId) => allowed.has(toolId));
}

/**
 * Tools an agent is requested to use that no connector, custom tool, or
 * first-party tool currently provides — i.e. capabilities that need an
 * integration attached before they can run.
 */
export function connectorPurposeGaps(
  store: JarvisStore,
  orgId: string,
): Array<{ toolId: string; requiredBy: string }> {
  const gaps: Array<{ toolId: string; requiredBy: string }> = [];
  const seen = new Set<string>();
  for (const agent of store.listAgents(orgId)) {
    for (const toolId of requestedToolsForAgent(store, orgId, agent.id)) {
      if (isFirstPartyTool(toolId) || seen.has(toolId)) {
        continue;
      }
      if (store.customToolById(orgId, toolId) || store.enabledCapability(orgId, toolId)) {
        continue;
      }
      seen.add(toolId);
      gaps.push({ toolId, requiredBy: "connector" });
    }
  }
  return gaps;
}
