import { connectorMatchesPurpose, type IntegrationPurpose } from "./providers.ts";
import { grantedToolsForAgent } from "./studio-access.ts";
import type { JarvisStore } from "./store.ts";

export type CapabilityStatus =
  | "FOUND"
  | "MULTIPLE"
  | "MISSING"
  | "DISABLED"
  | "NOT_GRANTED"
  | "AUTH_EXPIRED"
  | "UNVERIFIED";

/**
 * A capability Jarvis needs to reach an outcome, expressed as a canonical,
 * namespaced id (`commerce.customer.search`). `purpose` grounds the id to the
 * existing connector-purpose model so the resolver can match live connectors.
 */
export type RequiredCapability = {
  id: string;
  purpose: IntegrationPurpose;
  product?: string;
};

export type CapabilityResolution = {
  capability: RequiredCapability;
  status: CapabilityStatus;
  connectorId?: string;
  connectorIds?: string[];
};

/**
 * Optional per-connector health signal, injected by the runtime once Phase 4
 * connector-health tracking is available. Kept optional so Phase 1 stays a
 * pure, synchronous, dependency-light resolver.
 */
export type HealthLookup = (connectorId: string) =>
  | { state: string }
  | undefined;

function enabledToolIdsForConnector(store: JarvisStore, orgId: string, connectorId: string): string[] {
  return [...store.capabilities.values()]
    .filter((row) => row.orgId === orgId && row.connectorId === connectorId && row.enabled)
    .map((row) => row.toolId);
}

function resolveOne(
  store: JarvisStore,
  orgId: string,
  granted: Set<string>,
  capability: RequiredCapability,
  health?: HealthLookup,
): CapabilityResolution {
  const connectors = store
    .connectorsFor(orgId)
    .filter((row) => connectorMatchesPurpose(row.publicConfig.purpose, capability.purpose));
  if (connectors.length === 0) {
    return { capability, status: "MISSING" };
  }
  const active = connectors.filter((row) => row.status === "active");
  if (active.length === 0) {
    return { capability, status: "DISABLED", connectorId: connectors[0].id };
  }
  const chosen = active[0];
  if (health) {
    for (const connector of active) {
      const state = health(connector.id)?.state;
      if (state === "AUTH_EXPIRED") {
        return { capability, status: "AUTH_EXPIRED", connectorId: connector.id };
      }
    }
    for (const connector of active) {
      if (health(connector.id)?.state === "UNVERIFIED") {
        return { capability, status: "UNVERIFIED", connectorId: connector.id };
      }
    }
  }
  const toolIds = active.flatMap((row) => enabledToolIdsForConnector(store, orgId, row.id));
  if (toolIds.length > 0 && !toolIds.some((toolId) => granted.has(toolId))) {
    return { capability, status: "NOT_GRANTED", connectorId: chosen.id };
  }
  if (active.length > 1) {
    return {
      capability,
      status: "MULTIPLE",
      connectorId: chosen.id,
      connectorIds: active.map((row) => row.id),
    };
  }
  return { capability, status: "FOUND", connectorId: chosen.id };
}

/**
 * Resolve a set of required capabilities against the org's connectors and the
 * agent's grants. The single authority for "can Jarvis do this already?".
 *
 * @returns One resolution per required capability, in input order.
 */
export function resolveCapabilities(
  store: JarvisStore,
  orgId: string,
  agentId: string,
  required: RequiredCapability[],
  health?: HealthLookup,
): CapabilityResolution[] {
  const granted = new Set(grantedToolsForAgent(store, orgId, agentId));
  return required.map((capability) => resolveOne(store, orgId, granted, capability, health));
}

/** A resolution is a gap (needs connect / attention) unless it is usable now. */
export function isCapabilityGap(status: CapabilityStatus): boolean {
  return status !== "FOUND" && status !== "MULTIPLE";
}
