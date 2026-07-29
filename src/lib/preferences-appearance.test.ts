import assert from "node:assert/strict";
import {
  DEFAULT_SHELL_ZOOM,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_DENSITY,
  normalizeShellZoom,
  normalizeThemeMode,
  normalizeUiDensity,
  SHELL_ZOOM_OPTIONS,
} from "./preferences.ts";
import {
  getContentLeftInset,
  getMenuWidth,
  MENU_COLLAPSED_WIDTH,
  MENU_COMPACT_COLLAPSED_WIDTH,
  MENU_COMPACT_EXPANDED_WIDTH,
  MENU_EXPANDED_WIDTH,
} from "../config/layout.ts";

// normalizeThemeMode
{
  assert.equal(normalizeThemeMode("light"), "light");
  assert.equal(normalizeThemeMode("dark"), "dark");
  assert.equal(normalizeThemeMode("system"), "system");
  assert.equal(normalizeThemeMode(null), DEFAULT_THEME_MODE);
  assert.equal(normalizeThemeMode(undefined), DEFAULT_THEME_MODE);
  assert.equal(normalizeThemeMode("auto"), DEFAULT_THEME_MODE);
  assert.equal(normalizeThemeMode(1), DEFAULT_THEME_MODE);
}

// normalizeUiDensity
{
  assert.equal(normalizeUiDensity("comfortable"), "comfortable");
  assert.equal(normalizeUiDensity("compact"), "compact");
  assert.equal(normalizeUiDensity(null), DEFAULT_UI_DENSITY);
  assert.equal(normalizeUiDensity("cozy"), DEFAULT_UI_DENSITY);
}

// normalizeShellZoom
{
  for (const zoom of SHELL_ZOOM_OPTIONS) {
    assert.equal(normalizeShellZoom(zoom), zoom);
    assert.equal(normalizeShellZoom(String(zoom)), zoom);
  }
  assert.equal(normalizeShellZoom(100), 100);
  assert.equal(normalizeShellZoom("100"), 100);
  assert.equal(normalizeShellZoom(99), DEFAULT_SHELL_ZOOM);
  assert.equal(normalizeShellZoom("nope"), DEFAULT_SHELL_ZOOM);
  assert.equal(normalizeShellZoom(null), DEFAULT_SHELL_ZOOM);
}

// layout width / inset
{
  assert.equal(getMenuWidth(false, "comfortable"), MENU_EXPANDED_WIDTH);
  assert.equal(getMenuWidth(true, "comfortable"), MENU_COLLAPSED_WIDTH);
  assert.equal(getMenuWidth(false, "compact"), MENU_COMPACT_EXPANDED_WIDTH);
  assert.equal(getMenuWidth(true, "compact"), MENU_COMPACT_COLLAPSED_WIDTH);

  assert.equal(getContentLeftInset(false, "comfortable"), MENU_EXPANDED_WIDTH);
  assert.equal(
    getContentLeftInset(true, "compact"),
    MENU_COMPACT_COLLAPSED_WIDTH,
  );
}

console.log("preferences-appearance: ok");
