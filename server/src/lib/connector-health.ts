import type { HealthLookup } from "./capability-resolver.ts";
import type { JarvisStore } from "./store.ts";
import type { ConnectorHealth, ConnectorHealthState } from "./types.ts";

/**
 * Record (or update) the operational health of a connector. Keyed by
 * connectorId so the latest signal always wins — a single row per connector,
 * mirroring how `connectors`/`capabilities` are stored.
 *
 * @returns The stored health row.
 */
export function recordConnectorHealth(
  store: JarvisStore,
  input: { orgId: string; connectorId: string; state: ConnectorHealthState; detail?: string | null },
): ConnectorHealth {
  const row: ConnectorHealth = {
    connectorId: input.connectorId,
    orgId: input.orgId,
    state: input.state,
    detail: input.detail ?? null,
    checkedAt: new Date().toISOString(),
  };
  store.connectorHealth.set(input.connectorId, row);
  return row;
}

/** @returns The current health of a connector, if any has been recorded. */
export function getConnectorHealth(store: JarvisStore, connectorId: string): ConnectorHealth | undefined {
  return store.connectorHealth.get(connectorId);
}

/**
 * Build the resolver's health lookup from the store. The resolver stays pure —
 * it takes this function rather than reaching into the store itself.
 */
export function connectorHealthLookup(store: JarvisStore): HealthLookup {
  return (connectorId: string) => {
    const row = store.connectorHealth.get(connectorId);
    return row ? { state: row.state } : undefined;
  };
}

/**
 * Translate a runtime execution error string into a health state, or `null`
 * when the error is not a connector-health signal (e.g. bad user input).
 */
export function healthStateForError(error: string): ConnectorHealthState | null {
  if (error === "connector_missing" || error === "capability_missing") {
    return null;
  }
  if (/egress_denied|connector_unavailable|fetch failed|timeout|ENOTFOUND|ECONNREFUSED/i.test(error)) {
    return "UNREACHABLE";
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]token|expired/i.test(error)) {
    return "AUTH_EXPIRED";
  }
  return "DEGRADED";
}
