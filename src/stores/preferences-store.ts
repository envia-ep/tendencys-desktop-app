import { create } from "zustand";
import {
  DEFAULT_SERVICE_PREFERENCES,
  loadAllServicePreferences,
  prefsForService,
  saveServicePreferences,
  type LabelPrintMode,
  type ServicePreferences,
} from "@/lib/preferences";

type PreferencesState = {
  loaded: boolean;
  servicePrefs: Record<string, ServicePreferences>;
  loadPreferences: () => Promise<void>;
  getServicePreferences: (serviceId: string) => ServicePreferences;
  setLabelPrintMode: (
    serviceId: string,
    mode: LabelPrintMode,
  ) => Promise<void>;
  setLabelPrinter: (serviceId: string, printer: string) => Promise<void>;
};

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  loaded: false,
  servicePrefs: {},

  loadPreferences: async () => {
    const servicePrefs = await loadAllServicePreferences();
    set({ servicePrefs, loaded: true });
  },

  getServicePreferences: (serviceId) =>
    prefsForService(get().servicePrefs, serviceId),

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
