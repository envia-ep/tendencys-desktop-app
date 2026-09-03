import { isFirstPartyTool, resolveToolDef } from "./registry.ts";
import type { JarvisStore } from "./store.ts";
import type { PolicyOutcome } from "./types.ts";

export function evaluatePolicy(input: {
  store: JarvisStore;
  orgId: string;
  deviceId: string;
  agentToolIds: string[];
  grantedToolIds?: string[];
  principalId?: string;
  tool: string;
  grantId?: string | null;
}): PolicyOutcome {
  const def = resolveToolDef(input.store, input.orgId, input.tool);
  if (!def || def.privileged || def.risk === "privileged") {
    return "DENY";
  }
  if (isFirstPartyTool(input.tool)) {
    const listed =
      input.agentToolIds.includes(input.tool) ||
      (input.tool === "task.create" && Boolean(input.grantedToolIds?.includes(input.tool)));
    if (!listed) {
      return "DENY";
    }
    if (input.grantedToolIds && !input.grantedToolIds.includes(input.tool)) {
      return "DENY";
    }
  } else if (!input.grantedToolIds?.includes(input.tool)) {
    return "DENY";
  }
  if (input.principalId) {
    const recorded = input.store.policyOutcomeFor(input.orgId, input.principalId, input.tool);
    if (recorded === "DENY") {
      return "DENY";
    }
  }

  const grant = input.store.activeGrant({
    orgId: input.orgId,
    deviceId: input.deviceId,
    capability: input.tool,
  });
  const grantMatches = Boolean(
    grant && (!input.grantId || grant.grantId === input.grantId),
  );

  let outcome: PolicyOutcome = "DENY";
  if (def.risk === "sensitive_read") {
    outcome = grantMatches ? "ALLOW" : "ALLOW_WITH_APPROVAL";
  } else if (def.risk === "external_write" || def.risk === "destructive") {
    outcome = "ALLOW_WITH_APPROVAL";
  } else if (def.risk === "low") {
    outcome = "ALLOW";
  }
  if (input.principalId) {
    const recorded = input.store.policyOutcomeFor(input.orgId, input.principalId, input.tool);
    if (recorded === "ALLOW_WITH_APPROVAL" && outcome === "ALLOW") {
      return "ALLOW_WITH_APPROVAL";
    }
  }
  return outcome;
}
