/**
 * Shell chrome dimensions (logical px). Must stay in sync with the Rust side:
 * `DEFAULT_LEFT_INSET` / `AUTH_LEFT_INSET` in `src-tauri/src/webview_manager.rs`.
 * Product webviews use top=0; chrome is the full-height left menu only.
 */
export const MENU_COLLAPSED_WIDTH = 60;
export const MENU_EXPANDED_WIDTH = 220;
/** Left rail on LoginPage while the auth webview is open (matches AUTH_LEFT_INSET). */
export const LOGIN_RAIL_WIDTH = 56;
