import type { ToolRisk, ToolSide } from "./types.ts";

export const OPEN_SERVICE_IDS = [
  "envia-shipping",
  "envia-cargo",
  "envia-fulfillment",
  "envia-wms",
  "envia-returns",
  "parapaquetes",
  "ecart-pay",
  "ecart-banking",
  "ecart-api",
  "tendencys-partners",
  "home",
  "developers",
  "settings",
  "jarvis",
  "clients",
] as const;

export type OpenServiceId = (typeof OPEN_SERVICE_IDS)[number];

export type ToolDef = {
  id: string;
  side: ToolSide;
  risk: ToolRisk;
  privileged?: boolean;
};

export const TOOLS: Record<string, ToolDef> = {
  "memory.remember": { id: "memory.remember", side: "cloud", risk: "low" },
  "memory.recall": { id: "memory.recall", side: "cloud", risk: "low" },
  "desktop.open_service": {
    id: "desktop.open_service",
    side: "client",
    risk: "low",
  },
  "notify.show": { id: "notify.show", side: "native", risk: "low" },
  "clipboard.read": {
    id: "clipboard.read",
    side: "native",
    risk: "sensitive_read",
  },
  "clipboard.write": {
    id: "clipboard.write",
    side: "native",
    risk: "external_write",
  },
  "files.list": { id: "files.list", side: "native", risk: "sensitive_read" },
  "files.read": { id: "files.read", side: "native", risk: "sensitive_read" },
  "screenshots.capture": {
    id: "screenshots.capture",
    side: "native",
    risk: "privileged",
    privileged: true,
  },
  "linkedin.publish": {
    id: "linkedin.publish",
    side: "cloud",
    risk: "external_write",
  },
  "task.create": { id: "task.create", side: "cloud", risk: "low" },
  "task.update_current": { id: "task.update_current", side: "cloud", risk: "low" },
  "task.complete_current": { id: "task.complete_current", side: "cloud", risk: "low" },
  "web.search": { id: "web.search", side: "cloud", risk: "low" },
  "integrations.status": { id: "integrations.status", side: "cloud", risk: "low" },
  "integrations.connect": { id: "integrations.connect", side: "cloud", risk: "low" },
};

export function isOpenServiceId(value: string): value is OpenServiceId {
  return (OPEN_SERVICE_IDS as readonly string[]).includes(value);
}

export const DEFAULT_JARVIS_TOOLS = [
  "memory.remember",
  "memory.recall",
  "desktop.open_service",
  "notify.show",
  "clipboard.read",
  "clipboard.write",
  "files.list",
  "files.read",
  "task.update_current",
  "task.complete_current",
  "web.search",
  "integrations.status",
  "integrations.connect",
];
