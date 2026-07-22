const DOCK_TIP_DISMISSED_KEY = "tendencys.dock-tip.dismissed";

/** macOS desktop shell only — Keep in Dock is a Dock affordance. */
export function isMacOsDesktop(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|Macintosh/i.test(navigator.userAgent || navigator.platform || "");
}

export function shouldShowDockTip(): boolean {
  if (!isMacOsDesktop()) {
    return false;
  }
  try {
    return localStorage.getItem(DOCK_TIP_DISMISSED_KEY) !== "1";
  } catch {
    return false;
  }
}

export function dismissDockTip(): void {
  try {
    localStorage.setItem(DOCK_TIP_DISMISSED_KEY, "1");
  } catch {
    // ignore quota / private mode
  }
}
