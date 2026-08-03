import {
  migrateToLabelPrinterRules,
  normalizePrinterRules,
  type PrinterRule,
} from "./label-print-size";
import { isSupportedLanguage, type SupportedLanguage } from "./locale";
import {
  DEFAULT_MENU_LAYOUT,
  normalizeMenuLayout,
  type MenuLayout,
} from "./menu-layout";
import { isTauri } from "./tauri";

export type { PrinterRule } from "./label-print-size";
export type LabelPrintMode = "instant" | "system" | "save";

/**
 * Which set of service/Accounts URLs the shell points at. Canonical
 * definition lives here (alongside the other preference types) so
 * `@/config/environment` — which reads the live value from the preferences
 * store — can stay a one-way dependency on the store instead of a cycle.
 */
export type AppEnvironmentMode = "production" | "dev";
export const DEFAULT_ENVIRONMENT_MODE: AppEnvironmentMode = "production";

/** Shell chrome color scheme preference (product webviews are unaffected). */
export type ThemeMode = "light" | "dark" | "system";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

/** Shell chrome spacing density (rail padding / widths). */
export type UiDensity = "comfortable" | "compact";
export const DEFAULT_UI_DENSITY: UiDensity = "comfortable";

/** Shell UI zoom percent (React chrome only). */
export type ShellZoom = 90 | 100 | 110 | 125;
export const SHELL_ZOOM_OPTIONS: readonly ShellZoom[] = [90, 100, 110, 125];
export const DEFAULT_SHELL_ZOOM: ShellZoom = 100;

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_THEME_MODE;
}

export function normalizeUiDensity(value: unknown): UiDensity {
  return value === "comfortable" || value === "compact"
    ? value
    : DEFAULT_UI_DENSITY;
}

export function normalizeShellZoom(value: unknown): ShellZoom {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return (SHELL_ZOOM_OPTIONS as readonly number[]).includes(n)
    ? (n as ShellZoom)
    : DEFAULT_SHELL_ZOOM;
}

export type ServicePreferences = {
  labelPrintMode: LabelPrintMode;
  /** Instant fallback when no catalog size rule matches (empty = OS default). */
  labelPrinterDefault: string;
  /** Instant print: unbounded OS printers with assigned catalog_print_sizes. */
  labelPrinterRules: PrinterRule[];
};

export const DEFAULT_SERVICE_PREFERENCES: ServicePreferences = {
  labelPrintMode: "system",
  labelPrinterDefault: "",
  labelPrinterRules: [],
};

export type { CustomMenuItem, MenuLayout } from "./menu-layout";
export { DEFAULT_MENU_LAYOUT } from "./menu-layout";

const PREFERENCES_FILE = "preferences.json";
const SERVICE_PREFS_KEY = "servicePrefs";
const LANGUAGE_KEY = "language";
const ENVIRONMENT_KEY = "environmentMode";
const MENU_LAYOUT_KEY = "menuLayout";
const THEME_MODE_KEY = "themeMode";
const UI_DENSITY_KEY = "uiDensity";
const SHELL_ZOOM_KEY = "shellZoom";

function isAppEnvironmentModeValue(value: unknown): value is AppEnvironmentMode {
  return value === "production" || value === "dev";
}

async function getPreferencesStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(PREFERENCES_FILE, { autoSave: true, defaults: {} });
}

function normalizeLegacyBySize(
  raw: unknown,
): Partial<Record<"thermal_4x6" | "thermal_other" | "letter", string>> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<
    Record<"thermal_4x6" | "thermal_other" | "letter", string>
  > = {};
  for (const key of ["thermal_4x6", "thermal_other", "letter"] as const) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = value;
    }
  }
  return out;
}

export function normalizePrefs(raw: unknown): ServicePreferences {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_SERVICE_PREFERENCES,
      labelPrinterRules: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  const mode = obj.labelPrintMode;
  const labelPrintMode: LabelPrintMode =
    mode === "instant" || mode === "system" || mode === "save"
      ? mode
      : DEFAULT_SERVICE_PREFERENCES.labelPrintMode;

  const legacyPrinter =
    typeof obj.labelPrinter === "string" ? obj.labelPrinter : "";
  const labelPrinterDefault =
    typeof obj.labelPrinterDefault === "string"
      ? obj.labelPrinterDefault
      : legacyPrinter;

  const hadRules = Array.isArray(obj.labelPrinterRules);
  const hadBySize =
    obj.labelPrintersBySize != null && typeof obj.labelPrintersBySize === "object";

  let labelPrinterRules = normalizePrinterRules(obj.labelPrinterRules);
  if (!hadRules) {
    labelPrinterRules = migrateToLabelPrinterRules(
      normalizeLegacyBySize(obj.labelPrintersBySize),
      legacyPrinter || labelPrinterDefault,
      hadBySize,
    );
  }

  return { labelPrintMode, labelPrinterDefault, labelPrinterRules };
}

export async function loadAllServicePreferences(): Promise<
  Record<string, ServicePreferences>
> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    const raw =
      (await store.get<Record<string, unknown>>(SERVICE_PREFS_KEY)) ?? {};
    const out: Record<string, ServicePreferences> = {};
    for (const [id, value] of Object.entries(raw)) {
      out[id] = normalizePrefs(value);
    }
    return out;
  }

  try {
    const raw = localStorage.getItem(SERVICE_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ServicePreferences> = {};
    for (const [id, value] of Object.entries(parsed)) {
      out[id] = normalizePrefs(value);
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveServicePreferences(
  serviceId: string,
  prefs: ServicePreferences,
): Promise<void> {
  const all = await loadAllServicePreferences();
  all[serviceId] = normalizePrefs(prefs);

  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(SERVICE_PREFS_KEY, all);
    await store.save();
    return;
  }

  localStorage.setItem(SERVICE_PREFS_KEY, JSON.stringify(all));
}

export function prefsForService(
  all: Record<string, ServicePreferences>,
  serviceId: string,
): ServicePreferences {
  return all[serviceId]
    ? normalizePrefs(all[serviceId])
    : { ...DEFAULT_SERVICE_PREFERENCES };
}

/** Saved shell UI language, or null when unset / invalid. */
export async function loadLanguagePreference(): Promise<SupportedLanguage | null> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    const raw = await store.get<unknown>(LANGUAGE_KEY);
    return isSupportedLanguage(raw) ? raw : null;
  }

  try {
    const raw = localStorage.getItem(LANGUAGE_KEY);
    return isSupportedLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function saveLanguagePreference(
  language: SupportedLanguage,
): Promise<void> {
  if (!isSupportedLanguage(language)) {
    return;
  }

  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(LANGUAGE_KEY, language);
    await store.save();
    return;
  }

  localStorage.setItem(LANGUAGE_KEY, language);
}

/** Saved environment mode (Production/Dev), or null when unset / invalid. */
export async function loadEnvironmentMode(): Promise<AppEnvironmentMode | null> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    const raw = await store.get<unknown>(ENVIRONMENT_KEY);
    return isAppEnvironmentModeValue(raw) ? raw : null;
  }

  try {
    const raw = localStorage.getItem(ENVIRONMENT_KEY);
    return isAppEnvironmentModeValue(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function saveEnvironmentMode(
  mode: AppEnvironmentMode,
): Promise<void> {
  if (!isAppEnvironmentModeValue(mode)) {
    return;
  }

  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(ENVIRONMENT_KEY, mode);
    await store.save();
    return;
  }

  localStorage.setItem(ENVIRONMENT_KEY, mode);
}

/** Saved rail order + custom URLs, or defaults when unset / invalid. */
export async function loadMenuLayout(): Promise<MenuLayout> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    const raw = await store.get<unknown>(MENU_LAYOUT_KEY);
    return normalizeMenuLayout(raw ?? DEFAULT_MENU_LAYOUT);
  }

  try {
    const raw = localStorage.getItem(MENU_LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_MENU_LAYOUT, customItems: [] };
    return normalizeMenuLayout(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_MENU_LAYOUT, customItems: [] };
  }
}

export async function saveMenuLayout(layout: MenuLayout): Promise<void> {
  const normalized = normalizeMenuLayout(layout);

  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(MENU_LAYOUT_KEY, normalized);
    await store.save();
    return;
  }

  localStorage.setItem(MENU_LAYOUT_KEY, JSON.stringify(normalized));
}

/** Saved theme mode, or default when unset / invalid. */
export async function loadThemeMode(): Promise<ThemeMode> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    return normalizeThemeMode(await store.get<unknown>(THEME_MODE_KEY));
  }

  try {
    return normalizeThemeMode(localStorage.getItem(THEME_MODE_KEY));
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  const normalized = normalizeThemeMode(mode);
  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(THEME_MODE_KEY, normalized);
    await store.save();
    return;
  }
  localStorage.setItem(THEME_MODE_KEY, normalized);
}

/** Saved UI density, or default when unset / invalid. */
export async function loadUiDensity(): Promise<UiDensity> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    return normalizeUiDensity(await store.get<unknown>(UI_DENSITY_KEY));
  }

  try {
    return normalizeUiDensity(localStorage.getItem(UI_DENSITY_KEY));
  } catch {
    return DEFAULT_UI_DENSITY;
  }
}

export async function saveUiDensity(density: UiDensity): Promise<void> {
  const normalized = normalizeUiDensity(density);
  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(UI_DENSITY_KEY, normalized);
    await store.save();
    return;
  }
  localStorage.setItem(UI_DENSITY_KEY, normalized);
}

/** Saved shell zoom, or default when unset / invalid. */
export async function loadShellZoom(): Promise<ShellZoom> {
  if (isTauri()) {
    const store = await getPreferencesStore();
    return normalizeShellZoom(await store.get<unknown>(SHELL_ZOOM_KEY));
  }

  try {
    return normalizeShellZoom(localStorage.getItem(SHELL_ZOOM_KEY));
  } catch {
    return DEFAULT_SHELL_ZOOM;
  }
}

export async function saveShellZoom(zoom: ShellZoom): Promise<void> {
  const normalized = normalizeShellZoom(zoom);
  if (isTauri()) {
    const store = await getPreferencesStore();
    await store.set(SHELL_ZOOM_KEY, normalized);
    await store.save();
    return;
  }
  localStorage.setItem(SHELL_ZOOM_KEY, String(normalized));
}
