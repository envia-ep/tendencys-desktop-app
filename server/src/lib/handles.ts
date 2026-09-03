import type { JarvisStore } from "./store.ts";

const HANDLE_RE = /^@([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]+))?$/;

export function handleFromName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const slug = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug || "agent";
}

export function parseHandlePrefix(prompt: string): { handle: string; body: string } | null {
  const match = HANDLE_RE.exec(prompt.trim());
  if (!match) {
    return null;
  }
  return { handle: match[1].toLowerCase(), body: (match[2] ?? "").trim() };
}

export function uniqueHandle(store: JarvisStore, orgId: string, desired: string): string {
  const base = desired.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "agent";
  if (!store.findAgentByHandle(orgId, base)) {
    return base;
  }
  let n = 2;
  while (store.findAgentByHandle(orgId, `${base}${n}`)) {
    n += 1;
  }
  return `${base}${n}`;
}
