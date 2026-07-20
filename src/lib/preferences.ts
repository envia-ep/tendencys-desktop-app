import { isSupportedLanguage, type SupportedLanguage } from "./locale";
import { isTauri } from "./tauri";

export type LabelPrintMode = "instant" | "system" | "save";

export type ServicePreferences = {
  labelPrintMode: LabelPrintMode;
  /** Empty string = OS default printer when mode is instant. */
  labelPrinter: string;
};

export const DEFAULT_SERVICE_PREFERENCES: ServicePreferences = {
  labelPrintMode: "system",
  labelPrinter: "",
};

const PREFERENCES_FILE = "preferences.json";
const SERVICE_PREFS_KEY = "servicePrefs";
const LANGUAGE_KEY = "language";

async function getPreferencesStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(PREFERENCES_FILE, { autoSave: true, defaults: {} });
}

function normalizePrefs(raw: unknown): ServicePreferences {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SERVICE_PREFERENCES };
  }
  const obj = raw as Record<string, unknown>;
  const mode = obj.labelPrintMode;
  const labelPrintMode: LabelPrintMode =
    mode === "instant" || mode === "system" || mode === "save"
      ? mode
      : DEFAULT_SERVICE_PREFERENCES.labelPrintMode;
  const labelPrinter =
    typeof obj.labelPrinter === "string"
      ? obj.labelPrinter
      : DEFAULT_SERVICE_PREFERENCES.labelPrinter;
  return { labelPrintMode, labelPrinter };
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
