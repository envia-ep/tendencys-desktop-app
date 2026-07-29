import type { UiDensity } from "../lib/preferences";

/**
 * Shell chrome dimensions (logical px). Must stay in sync with the Rust side:
 * `DEFAULT_LEFT_INSET` in `src-tauri/src/webview_manager.rs`.
 * Product webviews use top=0; chrome is the full-height left menu only.
 *
 * Shell zoom scales rem typography only — these widths stay fixed so the
 * native webview inset does not need a zoom multiplier.
 */
export const MENU_COLLAPSED_WIDTH = 60;
export const MENU_EXPANDED_WIDTH = 220;

/** Compact density rail widths (logical px). */
export const MENU_COMPACT_COLLAPSED_WIDTH = 52;
export const MENU_COMPACT_EXPANDED_WIDTH = 180;

export function getMenuWidth(
  collapsed: boolean,
  density: UiDensity,
): number {
  if (density === "compact") {
    return collapsed
      ? MENU_COMPACT_COLLAPSED_WIDTH
      : MENU_COMPACT_EXPANDED_WIDTH;
  }
  return collapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH;
}

/** Left inset passed to native product webviews (matches rail width). */
export function getContentLeftInset(
  collapsed: boolean,
  density: UiDensity,
): number {
  return getMenuWidth(collapsed, density);
}
