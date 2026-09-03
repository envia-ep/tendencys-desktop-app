import { compileCapabilitiesOffline } from "./capability-compiler.ts";
import { resolveCapabilities } from "./capability-resolver.ts";
import { FIND_CHURNED_TOOL_ID } from "./custom-tools.ts";
import { parseHandlePrefix } from "./handles.ts";
import type { JarvisStore } from "./store.ts";
import { isOpenServiceId } from "./tools.ts";

export type PlannedAction = {
  tool: string;
  arguments: Record<string, unknown>;
  mention?: string;
};

export function looksLikeChurnWork(prompt: string): boolean {
  return /churned|find customers|send them a reminder|give a discount/i.test(prompt);
}

export function planRegistryFallback(
  store: JarvisStore,
  orgId: string,
  agentId: string,
  grantedToolIds: string[],
  prompt: string,
): { kind: "none" } | { kind: "gap"; message: string } | { kind: "actions"; actions: PlannedAction[] } {
  const required = compileCapabilitiesOffline(prompt);
  const resolutions = resolveCapabilities(store, orgId, agentId, required);
  // Only capabilities with no usable connector need the connect flow. NOT_GRANTED
  // / AUTH_EXPIRED are grant/health gaps (surfaced via resolve_integrations), not
  // reasons to re-attach an integration that already exists.
  const connectable = resolutions.filter(
    (row) => row.status === "MISSING" || row.status === "DISABLED",
  );
  if (connectable.length > 0) {
    return {
      kind: "actions",
      actions: connectable.map((row) => ({
        tool: "integrations.connect",
        arguments: row.capability.product
          ? { purpose: row.capability.purpose, product: row.capability.product }
          : { purpose: row.capability.purpose },
      })),
    };
  }
  if (!looksLikeChurnWork(prompt)) {
    return { kind: "none" };
  }
  const registered = Boolean(store.customToolById(orgId, FIND_CHURNED_TOOL_ID));
  if (!registered || !grantedToolIds.includes(FIND_CHURNED_TOOL_ID)) {
    return { kind: "none" };
  }
  return {
    kind: "actions",
    actions: [
      { tool: FIND_CHURNED_TOOL_ID, arguments: {} },
      { tool: "task.create", arguments: {} },
    ],
  };
}

export function planPrompt(prompt: string): PlannedAction[] {
  const text = prompt.trim();
  const mention = parseHandlePrefix(text);
  const body = mention ? mention.body || text : text;
  const lower = body.toLowerCase();
  const actions: PlannedAction[] = [];
  const tag = mention?.handle;

  if (/remember that/i.test(body) || /remember i /i.test(body)) {
    const content = body.replace(/^.*remember (that )?/i, "").trim();
    actions.push({
      tool: "memory.remember",
      arguments: {
        content,
        scopeType: /our |we |company|enterprise/i.test(content)
          ? "organization"
          : "personal",
        source: "explicit",
      },
    });
  } else if (/preference|prefer/i.test(lower) && /what/i.test(lower)) {
    actions.push({
      tool: "memory.recall",
      arguments: { query: body },
    });
  } else if (/clipboard/.test(lower) && /(what|read|currently)/.test(lower)) {
    actions.push({ tool: "clipboard.read", arguments: {} });
  } else if (/clipboard/.test(lower) && /(put|write|copy)/.test(lower)) {
    const content = body.replace(/^.*clipboard[:\s]*/i, "").trim() || body;
    actions.push({ tool: "clipboard.write", arguments: { content } });
  } else if (/read .*(file|invoice|folder|document)/i.test(lower)) {
    const pathMatch = body.match(/([A-Za-z0-9_\-./]+\.\w+)/);
    actions.push({
      tool: "files.read",
      arguments: {
        path: pathMatch?.[1] ?? "invoice.pdf",
        grantId: "workspace_work",
      },
    });
  } else if (/screenshot/i.test(lower)) {
    actions.push({ tool: "screenshots.capture", arguments: {} });
  } else if (/search|look up|find the (top|main)/i.test(lower)) {
    const query = body.replace(/^(please\s+)?((search\s+for|search|look\s+up|find(\s+the)?)\s+)/i, "").trim() || body;
    actions.push({
      tool: "web.search",
      arguments: { query },
    });
  } else if (/^open\s+/i.test(body)) {
    const raw = body.replace(/^open\s+/i, "").trim().toLowerCase().replace(/\.$/, "");
    const alias: Record<string, string> = {
      clients: "clients",
      partners: "tendencys-partners",
      home: "home",
      jarvis: "jarvis",
      shipping: "envia-shipping",
    };
    const serviceId = alias[raw] ?? raw;
    actions.push({
      tool: "desktop.open_service",
      arguments: { serviceId: isOpenServiceId(serviceId) ? serviceId : raw },
    });
  } else {
    actions.push({
      tool: "memory.recall",
      arguments: { query: body },
    });
  }

  if (tag) {
    return actions.map((action) => ({ ...action, mention: tag }));
  }
  return actions;
}
