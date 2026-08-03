import { create } from "zustand";
import i18n from "@/i18n";
import {
  detectLanguage,
  isSupportedLanguage,
  type SupportedLanguage,
} from "@/lib/locale";
import {
  addCustomToLayout,
  createCustomMenuId,
  DEFAULT_MENU_LAYOUT,
  normalizeCustomMenuInput,
  removeCustomFromLayout,
  updateCustomInLayout,
  withMenuOrder,
  type CustomMenuItem,
  type MenuLayout,
} from "@/lib/menu-layout";
import {
  DEFAULT_ENVIRONMENT_MODE,
  DEFAULT_SERVICE_PREFERENCES,
  DEFAULT_SHELL_ZOOM,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_DENSITY,
  loadAllServicePreferences,
  loadEnvironmentMode,
  loadLanguagePreference,
  loadMenuLayout,
  loadShellZoom,
  loadThemeMode,
  loadUiDensity,
  normalizeShellZoom,
  normalizeThemeMode,
  normalizeUiDensity,
  prefsForService,
  saveEnvironmentMode,
  saveLanguagePreference,
  saveMenuLayout,
  saveServicePreferences,
  saveShellZoom,
  saveThemeMode,
  saveUiDensity,
  type AppEnvironmentMode,
  type LabelPrintMode,
  type PrinterRule,
  type ServicePreferences,
  type ShellZoom,
  type ThemeMode,
  type UiDensity,
} from "@/lib/preferences";

type PreferencesState = {
  loaded: boolean;
  language: SupportedLanguage;
  servicePrefs: Record<string, ServicePreferences>;
  environmentMode: AppEnvironmentMode;
  menuLayout: MenuLayout;
  themeMode: ThemeMode;
  uiDensity: UiDensity;
  shellZoom: ShellZoom;
  loadPreferences: () => Promise<void>;
  getServicePreferences: (serviceId: string) => ServicePreferences;
  setLanguage: (language: SupportedLanguage) => Promise<void>;
  setLabelPrintMode: (
    serviceId: string,
    mode: LabelPrintMode,
  ) => Promise<void>;
  setLabelPrinterDefault: (serviceId: string, printer: string) => Promise<void>;
  setLabelPrinterRules: (
    serviceId: string,
    rules: PrinterRule[],
  ) => Promise<void>;
  /** Persists the mode only — callers own the session-reset + restart flow. */
  setEnvironmentMode: (mode: AppEnvironmentMode) => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setUiDensity: (density: UiDensity) => Promise<void>;
  setShellZoom: (zoom: ShellZoom) => Promise<void>;
  setMenuOrder: (order: string[]) => Promise<void>;
  /**
   * @param currentRailIds Current composed rail ids so the first custom
   * appends after the catalog when `order` is still empty.
   */
  addCustomMenuItem: (
    name: string,
    url: string,
    currentRailIds?: string[],
  ) => Promise<CustomMenuItem | null>;
  updateCustomMenuItem: (
    id: string,
    name: string,
    url: string,
  ) => Promise<boolean>;
  removeCustomMenuItem: (id: string) => Promise<void>;
};

function resolveInitialLanguage(): SupportedLanguage {
  const detected = detectLanguage();
  return isSupportedLanguage(detected) ? detected : "en";
}

async function persistMenuLayout(
  layout: MenuLayout,
  set: (partial: Partial<PreferencesState>) => void,
): Promise<void> {
  await saveMenuLayout(layout);
  set({ menuLayout: layout });
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  loaded: false,
  language: resolveInitialLanguage(),
  servicePrefs: {},
  environmentMode: DEFAULT_ENVIRONMENT_MODE,
  menuLayout: { ...DEFAULT_MENU_LAYOUT, customItems: [] },
  themeMode: DEFAULT_THEME_MODE,
  uiDensity: DEFAULT_UI_DENSITY,
  shellZoom: DEFAULT_SHELL_ZOOM,

  loadPreferences: async () => {
    const [
      servicePrefs,
      savedLanguage,
      savedEnvironmentMode,
      menuLayout,
      themeMode,
      uiDensity,
      shellZoom,
    ] = await Promise.all([
      loadAllServicePreferences(),
      loadLanguagePreference(),
      loadEnvironmentMode(),
      loadMenuLayout(),
      loadThemeMode(),
      loadUiDensity(),
      loadShellZoom(),
    ]);
    const language = savedLanguage ?? resolveInitialLanguage();
    if (i18n.language !== language) {
      await i18n.changeLanguage(language);
    }
    set({
      servicePrefs,
      language,
      environmentMode: savedEnvironmentMode ?? DEFAULT_ENVIRONMENT_MODE,
      menuLayout,
      themeMode,
      uiDensity,
      shellZoom,
      loaded: true,
    });
  },

  getServicePreferences: (serviceId) =>
    prefsForService(get().servicePrefs, serviceId),

  setLanguage: async (language) => {
    if (!isSupportedLanguage(language)) {
      return;
    }
    await saveLanguagePreference(language);
    await i18n.changeLanguage(language);
    set({ language });
  },

  setLabelPrintMode: async (serviceId, mode) => {
    const current = prefsForService(get().servicePrefs, serviceId);
    const next = { ...current, labelPrintMode: mode };
    await saveServicePreferences(serviceId, next);
    set((state) => ({
      servicePrefs: { ...state.servicePrefs, [serviceId]: next },
    }));
  },

  setLabelPrinterDefault: async (serviceId, printer) => {
    const current = prefsForService(get().servicePrefs, serviceId);
    const next = { ...current, labelPrinterDefault: printer };
    await saveServicePreferences(serviceId, next);
    set((state) => ({
      servicePrefs: { ...state.servicePrefs, [serviceId]: next },
    }));
  },

  setLabelPrinterRules: async (serviceId, rules) => {
    const current = prefsForService(get().servicePrefs, serviceId);
    const next = { ...current, labelPrinterRules: rules };
    await saveServicePreferences(serviceId, next);
    set((state) => ({
      servicePrefs: { ...state.servicePrefs, [serviceId]: next },
    }));
  },

  setEnvironmentMode: async (mode) => {
    await saveEnvironmentMode(mode);
    set({ environmentMode: mode });
  },

  setThemeMode: async (mode) => {
    const themeMode = normalizeThemeMode(mode);
    await saveThemeMode(themeMode);
    set({ themeMode });
  },

  setUiDensity: async (density) => {
    const uiDensity = normalizeUiDensity(density);
    await saveUiDensity(uiDensity);
    set({ uiDensity });
  },

  setShellZoom: async (zoom) => {
    const shellZoom = normalizeShellZoom(zoom);
    await saveShellZoom(shellZoom);
    set({ shellZoom });
  },

  setMenuOrder: async (order) => {
    const next = withMenuOrder(get().menuLayout, order);
    await persistMenuLayout(next, set);
  },

  addCustomMenuItem: async (name, url, currentRailIds = []) => {
    const normalized = normalizeCustomMenuInput(name, url);
    if (!normalized) return null;
    const item: CustomMenuItem = {
      id: createCustomMenuId(),
      name: normalized.name,
      url: normalized.url,
    };
    const next = addCustomToLayout(get().menuLayout, item, currentRailIds);
    await persistMenuLayout(next, set);
    return item;
  },

  updateCustomMenuItem: async (id, name, url) => {
    const normalized = normalizeCustomMenuInput(name, url);
    if (!normalized) return false;
    if (!get().menuLayout.customItems.some((item) => item.id === id)) {
      return false;
    }
    const next = updateCustomInLayout(get().menuLayout, id, normalized);
    await persistMenuLayout(next, set);
    return true;
  },

  removeCustomMenuItem: async (id) => {
    const next = removeCustomFromLayout(get().menuLayout, id);
    await persistMenuLayout(next, set);
  },
}));

export { DEFAULT_SERVICE_PREFERENCES };
