import { id } from "./ids.ts";
import type { JarvisStore } from "./store.ts";
import type { Capability, CapabilityVersion, Connector, ConnectorVersion } from "./types.ts";

/**
 * Ensure an immutable snapshot exists for a connector at its current revision.
 * Idempotent: re-attaching the same revision returns the existing version row
 * rather than minting a duplicate, so runs keep a stable reference.
 *
 * @returns The connector version snapshot for `connector.revision`.
 */
export function recordConnectorVersion(store: JarvisStore, connector: Connector): ConnectorVersion {
  const existing = [...store.connectorVersions.values()].find(
    (row) => row.connectorId === connector.id && row.revision === connector.revision,
  );
  if (existing) {
    return existing;
  }
  const version: ConnectorVersion = {
    id: id("cnv"),
    connectorId: connector.id,
    orgId: connector.orgId,
    revision: connector.revision,
    specHash: connector.specHash,
    publicConfig: connector.publicConfig,
    createdAt: new Date().toISOString(),
  };
  store.connectorVersions.set(version.id, version);
  return version;
}

/**
 * Ensure an immutable snapshot exists for a capability version, linked to its
 * connector version. Idempotent on (orgId, toolId, version).
 *
 * @returns The capability version snapshot.
 */
export function recordCapabilityVersion(
  store: JarvisStore,
  capability: Capability,
  connectorVersionId: string,
): CapabilityVersion {
  const existing = [...store.capabilityVersions.values()].find(
    (row) => row.orgId === capability.orgId && row.toolId === capability.toolId && row.version === capability.version,
  );
  if (existing) {
    return existing;
  }
  const version: CapabilityVersion = {
    id: id("cpv"),
    capabilityId: capability.id,
    connectorVersionId,
    orgId: capability.orgId,
    toolId: capability.toolId,
    version: capability.version,
    side: capability.side,
    risk: capability.risk,
    binding: capability.binding,
    createdAt: new Date().toISOString(),
  };
  store.capabilityVersions.set(version.id, version);
  return version;
}

/** @returns The latest connector version snapshot for a connector, if any. */
export function latestConnectorVersion(store: JarvisStore, connectorId: string): ConnectorVersion | undefined {
  return [...store.connectorVersions.values()]
    .filter((row) => row.connectorId === connectorId)
    .sort((a, b) => b.revision - a.revision)[0];
}

/**
 * Resolve the version ids a run should reference when invoking a cloud tool:
 * the enabled capability's snapshot and its connector snapshot. Returns nulls
 * when the tool is not a versioned connector capability (local/native tools).
 */
export function versionRefsForTool(
  store: JarvisStore,
  orgId: string,
  toolId: string,
): { connectorVersionId: string | null; capabilityVersionId: string | null } {
  const capability = store.enabledCapability(orgId, toolId);
  if (!capability) {
    return { connectorVersionId: null, capabilityVersionId: null };
  }
  const capabilityVersion = [...store.capabilityVersions.values()].find(
    (row) => row.orgId === orgId && row.toolId === toolId && row.version === capability.version,
  );
  return {
    connectorVersionId: capabilityVersion?.connectorVersionId ?? null,
    capabilityVersionId: capabilityVersion?.id ?? null,
  };
}
