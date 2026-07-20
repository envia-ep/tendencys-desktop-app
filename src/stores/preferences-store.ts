import { create } from "zustand";
import i18n from "@/i18n";
import {
  detectLanguage,
  isSupportedLanguage,
  type SupportedLanguage,
} from "@/lib/locale";
import {
  DEFAULT_SERVICE_PREFERENCES,
  loadAllServicePreferences,
  loadLanguagePreference,
  prefsForService,
  saveLanguagePreference,
  saveServicePreferences,
  type LabelPrintMode,
  type ServicePreferences,
} from "@/lib/preferences";

type PreferencesState = {
  loaded: boolean;
  language: SupportedLanguage;
  servicePrefs: Record<string, ServicePreferences>;
  loadPreferences: () => Promise<void>;
  getServicePreferences: (serviceId: string) => ServicePreferences;
  setLanguage: (language: SupportedLanguage) => Promise<void>;
  setLabelPrintMode: (
    serviceId: string,
    mode: LabelPrintMode,
  ) => Promise<void>;
  setLabelPrinter: (serviceId: string, printer: string) => Promise<void>;
};

function resolveInitialLanguage(): SupportedLanguage {
  const detected = detectLanguage();
  return isSupportedLanguage(detected) ? detected : "en";
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  loaded: false,
  language: resolveInitialLanguage(),
  servicePrefs: {},

  loadPreferences: async () => {
    const [servicePrefs, savedLanguage] = await Promise.all([
      loadAllServicePreferences(),
      loadLanguagePreference(),
    ]);
    const language = savedLanguage ?? resolveInitialLanguage();
    if (i18n.language !== language) {
      await i18n.changeLanguage(language);
    }
    set({ servicePrefs, language, loaded: true });
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

  setLabelPrinter: async (serviceId, printer) => {
    const current = prefsForService(get().servicePrefs, serviceId);
    const next = { ...current, labelPrinter: printer };
    await saveServicePreferences(serviceId, next);
    set((state) => ({
      servicePrefs: { ...state.servicePrefs, [serviceId]: next },
    }));
  },
}));

export { DEFAULT_SERVICE_PREFERENCES };
