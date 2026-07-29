import type { ShellZoom, ThemeMode, UiDensity } from "./preferences";

const DARK_CLASS = "dark";
const COLOR_SCHEME_MEDIA = "(prefers-color-scheme: dark)";

export function prefersDarkColorScheme(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia(COLOR_SCHEME_MEDIA).matches;
}

export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return prefersDarkColorScheme() ? "dark" : "light";
  }
  return mode;
}

/** Apply resolved light/dark to `<html>` (class + color-scheme). */
export function applyResolvedTheme(resolved: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, resolved === "dark");
  root.style.colorScheme = resolved;
}

/**
 * Scale shell typography via root `font-size` (rem). Do not use CSS `zoom` —
 * that shrinks the whole layout and leaves empty window chrome.
 */
export function applyShellZoom(zoom: ShellZoom): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.zoom = "";
  root.style.setProperty("--shell-font-scale", String(zoom / 100));
  root.dataset.zoom = String(zoom);
}

export function applyUiDensity(density: UiDensity): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = density;
}

/**
 * Apply theme, density, and zoom to the document. When `themeMode` is
 * `system`, subscribes to OS preference changes until the returned disposer runs.
 */
export function applyAppearance(options: {
  themeMode: ThemeMode;
  uiDensity: UiDensity;
  shellZoom: ShellZoom;
}): () => void {
  applyUiDensity(options.uiDensity);
  applyShellZoom(options.shellZoom);
  applyResolvedTheme(resolveThemeMode(options.themeMode));

  if (options.themeMode !== "system" || typeof window === "undefined") {
    return () => undefined;
  }

  const media = window.matchMedia(COLOR_SCHEME_MEDIA);
  const onChange = () => {
    applyResolvedTheme(resolveThemeMode("system"));
  };
  media.addEventListener("change", onChange);
  return () => {
    media.removeEventListener("change", onChange);
  };
}
