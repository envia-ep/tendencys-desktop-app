/** Session-scoped chronological navigation stack across services + in-app URLs. */

export type ShellHistoryEntry = {
  serviceId: string;
  /** Absolute product URL (pathname+search+hash on the service origin). */
  url: string;
};

const MAX_ENTRIES = 100;

export type ShellHistory = {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  current: () => ShellHistoryEntry | null;
  isTraversing: () => boolean;
  setTraversing: (value: boolean) => void;
  push: (entry: ShellHistoryEntry) => void;
  replace: (entry: ShellHistoryEntry) => void;
  back: () => ShellHistoryEntry | null;
  forward: () => ShellHistoryEntry | null;
  clear: () => void;
};

export function createShellHistory(): ShellHistory {
  let stack: ShellHistoryEntry[] = [];
  let index = -1;
  let traversing = false;

  const same = (a: ShellHistoryEntry, b: ShellHistoryEntry) =>
    a.serviceId === b.serviceId && a.url === b.url;

  return {
    canGoBack: () => index > 0,
    canGoForward: () => index >= 0 && index < stack.length - 1,
    current: () => (index >= 0 ? stack[index]! : null),
    isTraversing: () => traversing,
    setTraversing: (value) => {
      traversing = value;
    },
    push: (entry) => {
      if (traversing) return;
      const tip = index >= 0 ? stack[index] : null;
      if (tip && same(tip, entry)) return;
      stack = stack.slice(0, index + 1);
      stack.push(entry);
      if (stack.length > MAX_ENTRIES) {
        stack = stack.slice(stack.length - MAX_ENTRIES);
      }
      index = stack.length - 1;
    },
    replace: (entry) => {
      if (traversing) return;
      if (index < 0) {
        stack = [entry];
        index = 0;
        return;
      }
      stack[index] = entry;
    },
    back: () => {
      if (index <= 0) return null;
      index -= 1;
      return stack[index]!;
    },
    forward: () => {
      if (index < 0 || index >= stack.length - 1) return null;
      index += 1;
      return stack[index]!;
    },
    clear: () => {
      stack = [];
      index = -1;
      traversing = false;
    },
  };
}

/** Drop query noise from Accounts SSO / auth handoff URLs. */
export function isAuthNoiseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("accounts")) return true;
    if (u.pathname === "/login" || u.pathname === "/login-sites") return true;
    if (u.pathname.includes("/authentication") && u.search.includes("authorization=")) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function pathFromServiceUrl(serviceUrl: string, absoluteUrl: string): string {
  try {
    const base = new URL(serviceUrl);
    const u = new URL(absoluteUrl);
    if (u.origin !== base.origin) return absoluteUrl;
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return "/";
  }
}
