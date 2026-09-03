import type { JarvisStore } from "./store.ts";
import { inheritCustomRisk } from "./registry.ts";
import type { CustomTool, CustomToolDefinition, ToolRisk } from "./types.ts";
import { id } from "./ids.ts";

const MAX_STEPS = 3;
const MAX_ROWS = 500;

export type CustomToolExecute = (
  toolId: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.items)) {
      return asRecords(row.items);
    }
    if (Array.isArray(row.customers)) {
      return asRecords(row.customers);
    }
  }
  return [];
}

function getPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, row);
}

function applyFilter(rows: Array<Record<string, unknown>>, filter?: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!filter) {
    return rows;
  }
  return rows.filter((row) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = getPath(row, key);
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const cmp = expected as { lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown; eq?: unknown };
        if ("lt" in cmp) {
          return Number(actual) < Number(cmp.lt);
        }
        if ("lte" in cmp) {
          return Number(actual) <= Number(cmp.lte);
        }
        if ("gt" in cmp) {
          return Number(actual) > Number(cmp.gt);
        }
        if ("gte" in cmp) {
          return Number(actual) >= Number(cmp.gte);
        }
        if ("eq" in cmp) {
          return actual === cmp.eq;
        }
      }
      return actual === expected;
    }),
  );
}

function applyMap(rows: Array<Record<string, unknown>>, map?: Record<string, string>): Array<Record<string, unknown>> {
  if (!map) {
    return rows;
  }
  return rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [to, from] of Object.entries(map)) {
      next[to] = getPath(row, from);
    }
    return next;
  });
}

export function findChurnedDefinition(
  listToolId: string,
  version: number,
  cutoffDays = 90,
): CustomToolDefinition {
  return {
    steps: [
      {
        toolId: listToolId,
        version,
        filter: { daysSinceLastOrder: { gte: cutoffDays } },
      },
    ],
    groupBy: ["country", "language"],
    cap: MAX_ROWS,
    cutoffDays,
  };
}

export function saveCustomTool(
  store: JarvisStore,
  input: {
    orgId: string;
    toolId: string;
    definition: CustomToolDefinition;
  },
): CustomTool {
  if (input.definition.steps.length === 0 || input.definition.steps.length > MAX_STEPS) {
    throw new Error("custom_tool_steps");
  }
  const existing = store.customToolById(input.orgId, input.toolId);
  const draft: CustomTool = {
    id: existing?.id ?? id("ctl"),
    orgId: input.orgId,
    toolId: input.toolId,
    definition: {
      ...input.definition,
      cap: Math.min(input.definition.cap ?? MAX_ROWS, MAX_ROWS),
    },
    risk: "low",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  draft.risk = inheritCustomRisk(store, input.orgId, draft);
  store.customTools.set(draft.id, draft);
  return draft;
}

export async function executeCustomTool(
  store: JarvisStore,
  orgId: string,
  toolId: string,
  args: Record<string, unknown>,
  executeStep: CustomToolExecute,
  grantedToolIds?: string[],
): Promise<{ result: unknown; risk: ToolRisk } | { error: string }> {
  const custom = store.customToolById(orgId, toolId);
  if (!custom) {
    return { error: "custom_tool_missing" };
  }
  if (custom.definition.steps.length > MAX_STEPS) {
    return { error: "custom_tool_steps" };
  }
  let rows: Array<Record<string, unknown>> = [];
  for (const step of custom.definition.steps) {
    const capability = [...store.capabilities.values()].find(
      (row) =>
        row.orgId === orgId &&
        row.toolId === step.toolId &&
        row.version === step.version &&
        row.enabled,
    );
    if (!capability || (grantedToolIds && !grantedToolIds.includes(step.toolId))) {
      return { error: "step_ungranted" };
    }
    const raw = await executeStep(step.toolId, { ...args, ...(step.map ?? {}) });
    rows = applyMap(applyFilter(asRecords(raw), step.filter), step.map);
    if (rows.length > MAX_ROWS) {
      rows = rows.slice(0, MAX_ROWS);
    }
  }
  const groupKeys = custom.definition.groupBy ?? [];
  if (groupKeys.length === 0) {
    return { result: { items: rows.slice(0, custom.definition.cap ?? MAX_ROWS) }, risk: inheritCustomRisk(store, orgId, custom) };
  }
  const buckets = new Map<string, { country: string; language: string; count: number; items: Array<Record<string, unknown>> }>();
  for (const row of rows) {
    const country = String(getPath(row, groupKeys[0] ?? "country") ?? "");
    const language = String(getPath(row, groupKeys[1] ?? "language") ?? "");
    const key = `${country}|${language}`;
    const bucket = buckets.get(key) ?? { country, language, count: 0, items: [] };
    bucket.count += 1;
    if (bucket.items.length < 20) {
      bucket.items.push(row);
    }
    buckets.set(key, bucket);
  }
  const segments = [...buckets.values()];
  return {
    result: {
      total: rows.length,
      segments: segments.map(({ country, language, count }) => ({ country, language, count })),
      items: segments.flatMap((segment) => segment.items).slice(0, custom.definition.cap ?? MAX_ROWS),
    },
    risk: inheritCustomRisk(store, orgId, custom),
  };
}

export const FIND_CHURNED_TOOL_ID = "customers.find_churned";
