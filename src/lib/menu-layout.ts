import type { ServiceDefinition } from "@/config/services";

export type CustomMenuItem = {
  id: string;
  name: string;
  url: string;
};

export type MenuLayout = {
  /** Built-in + custom ids in rail order. Empty = catalog order. */
  order: string[];
  customItems: CustomMenuItem[];
};

export const DEFAULT_MENU_LAYOUT: MenuLayout = {
  order: [],
  customItems: [],
};

export const CUSTOM_MENU_ACCENT = "#64748B";
export const CUSTOM_MENU_ICON = "custom";

const CUSTOM_ID_PREFIX = "custom-";

export function isCustomMenuId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

export function createCustomMenuId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${CUSTOM_ID_PREFIX}${crypto.randomUUID()}`;
  }
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Trim name/url; require non-empty name and http(s) URL. */
export function normalizeCustomMenuInput(
  name: string,
  url: string,
): { name: string; url: string } | null {
  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  if (!trimmedName || !trimmedUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return { name: trimmedName, url: parsed.toString() };
}

export function customItemToService(item: CustomMenuItem): ServiceDefinition {
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    siteId: "",
    icon: CUSTOM_MENU_ICON,
    accentColor: CUSTOM_MENU_ACCENT,
    quickLinks: [],
    authMode: "unsupported",
    authCallbackPath: "/",
  };
}

export function normalizeMenuLayout(raw: unknown): MenuLayout {
  if (!raw || typeof raw !== "object") {
    return { order: [], customItems: [] };
  }
  const obj = raw as Record<string, unknown>;
  const order = Array.isArray(obj.order)
    ? obj.order.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const customItems: CustomMenuItem[] = [];
  if (Array.isArray(obj.customItems)) {
    for (const entry of obj.customItems) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || !isCustomMenuId(item.id)) continue;
      if (typeof item.name !== "string" || typeof item.url !== "string") continue;
      const normalized = normalizeCustomMenuInput(item.name, item.url);
      if (!normalized) continue;
      customItems.push({
        id: item.id,
        name: normalized.name,
        url: normalized.url,
      });
    }
  }
  return { order, customItems };
}

/**
 * Merge catalog visibility with user order + custom URLs.
 * Unknown / orphan ids in `order` are skipped; new catalog ids append in
 * catalog order; customs missing from `order` append after catalog leftovers.
 */
export function composeMenuServices(
  visibleBuiltIns: ServiceDefinition[],
  layout: MenuLayout,
): ServiceDefinition[] {
  const builtInById = new Map(visibleBuiltIns.map((s) => [s.id, s]));
  const customById = new Map(
    layout.customItems.map((item) => [item.id, customItemToService(item)]),
  );
  const seen = new Set<string>();
  const result: ServiceDefinition[] = [];

  for (const id of layout.order) {
    if (seen.has(id)) continue;
    const builtIn = builtInById.get(id);
    if (builtIn) {
      result.push(builtIn);
      seen.add(id);
      continue;
    }
    const custom = customById.get(id);
    if (custom) {
      result.push(custom);
      seen.add(id);
    }
  }

  for (const service of visibleBuiltIns) {
    if (seen.has(service.id)) continue;
    result.push(service);
    seen.add(service.id);
  }

  for (const item of layout.customItems) {
    if (seen.has(item.id)) continue;
    result.push(customItemToService(item));
    seen.add(item.id);
  }

  return result;
}

export function resolveServiceById(
  id: string,
  layout: MenuLayout,
  getBuiltIn: (id: string) => ServiceDefinition | undefined,
): ServiceDefinition | undefined {
  const builtIn = getBuiltIn(id);
  if (builtIn) return builtIn;
  const custom = layout.customItems.find((item) => item.id === id);
  return custom ? customItemToService(custom) : undefined;
}

/** Apply a new id order (e.g. after drag-and-drop). */
export function withMenuOrder(layout: MenuLayout, order: string[]): MenuLayout {
  return { ...layout, order: [...order] };
}

export function addCustomToLayout(
  layout: MenuLayout,
  item: CustomMenuItem,
  /** Current rail ids so a first custom appends after the visible catalog. */
  currentRailIds: string[] = [],
): MenuLayout {
  const baseOrder =
    layout.order.length > 0 ? [...layout.order] : [...currentRailIds];
  const order = baseOrder.includes(item.id)
    ? baseOrder
    : [...baseOrder, item.id];
  return {
    order,
    customItems: [...layout.customItems, item],
  };
}

export function updateCustomInLayout(
  layout: MenuLayout,
  id: string,
  patch: { name: string; url: string },
): MenuLayout {
  return {
    ...layout,
    customItems: layout.customItems.map((item) =>
      item.id === id ? { ...item, name: patch.name, url: patch.url } : item,
    ),
  };
}

export function removeCustomFromLayout(
  layout: MenuLayout,
  id: string,
): MenuLayout {
  return {
    order: layout.order.filter((entry) => entry !== id),
    customItems: layout.customItems.filter((item) => item.id !== id),
  };
}
