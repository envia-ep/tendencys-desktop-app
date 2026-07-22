/**
 * Known product tabs — keep in sync with `src/config/services.ts` `SERVICES`.
 * Listed here (not imported) so deep-link parsing stays dependency-light.
 */
export const OPEN_SERVICE_IDS = [
  "envia-shipping",
  "envia-cargo",
  "envia-fulfillment",
  "envia-returns",
  "parapaquetes",
  "ecart-pay",
  "ecart-banking",
  "ecart-api",
  "tendencys-partners",
] as const;

/**
 * Shell hub sections (not product webviews).
 * Keep in sync with `ShellView` in `src/stores/service-store.ts` (minus `"service"`).
 * When adding a new ShellView section, add its id here and in Rust `OPEN_TARGET_IDS`.
 */
export const OPEN_SHELL_SECTION_IDS = ["home", "developers", "settings"] as const;

export type OpenServiceId = (typeof OPEN_SERVICE_IDS)[number];
export type OpenShellSectionId = (typeof OPEN_SHELL_SECTION_IDS)[number];
export type OpenTargetKind = "service" | "section";

export type OpenTarget = {
  kind: OpenTargetKind;
  id: string;
};

/** Queues a `tendencys://open/<target>` until the shell is authenticated. */
let pendingTarget: OpenTarget | null = null;

export function setPendingOpenTarget(target: OpenTarget): void {
  pendingTarget = target;
}

export function takePendingOpenTarget(): OpenTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

export function isOpenServiceId(id: string): id is OpenServiceId {
  return (OPEN_SERVICE_IDS as readonly string[]).includes(id);
}

export function isOpenShellSectionId(id: string): id is OpenShellSectionId {
  return (OPEN_SHELL_SECTION_IDS as readonly string[]).includes(id);
}

export function buildOpenDeepLink(targetId: string): string {
  return `tendencys://open/${targetId}`;
}

/** Deep links for every product tab + shell section. */
export const OPEN_DEEP_LINKS: Record<string, string> = Object.fromEntries(
  [...OPEN_SERVICE_IDS, ...OPEN_SHELL_SECTION_IDS].map((id) => [
    id,
    buildOpenDeepLink(id),
  ]),
);

export function resolveOpenTargetId(id: string): OpenTarget | null {
  if (isOpenServiceId(id)) {
    return { kind: "service", id };
  }
  if (isOpenShellSectionId(id)) {
    return { kind: "section", id };
  }
  return null;
}

/**
 * Parse `tendencys://open/<target>` → known service or shell section, or null.
 */
export function extractOpenTarget(
  raw: string,
  scheme = "tendencys",
): OpenTarget | null {
  let candidate: string | null = null;
  try {
    const url = new URL(raw);
    if (url.protocol !== `${scheme}:`) return null;
    const host = url.host || "";
    const path = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    if (host !== "open" || !path || path.includes("/")) return null;
    candidate = path;
  } catch {
    const match = raw.match(new RegExp(`^${scheme}://open/([^/?#]+)`, "i"));
    candidate = match?.[1] ?? null;
  }
  if (!candidate) return null;
  return resolveOpenTargetId(candidate);
}
