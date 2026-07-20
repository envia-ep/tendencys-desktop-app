/** Languages the app ships UI copy for. First entry is the fallback. */
export const SUPPORTED_LANGUAGES = [
  "en",
  "es",
  "pt",
  "hi",
  "it",
  "fr",
  "zh",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Endonyms for the language selector — never translate these via `t()`.
 * Users must always find their language by its own name.
 */
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Español",
  pt: "Português",
  hi: "हिन्दी",
  it: "Italiano",
  fr: "Français",
  zh: "中文",
};

/** BCP-47 tags for `toLocaleString` / number formatting. */
export const NUMBER_LOCALES: Record<SupportedLanguage, string> = {
  en: "en-US",
  es: "es-MX",
  pt: "pt-BR",
  hi: "hi-IN",
  it: "it-IT",
  fr: "fr-FR",
  zh: "zh-CN",
};

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

export function numberLocaleFor(language: string): string {
  const base = language.toLowerCase().split("-")[0] ?? "";
  if (isSupportedLanguage(base)) {
    return NUMBER_LOCALES[base];
  }
  return NUMBER_LOCALES.en;
}

/**
 * Pick the best supported language from an ordered list of BCP-47 tags
 * (most-preferred first, e.g. `navigator.languages`). Region subtags are
 * ignored — only the base language matters (`es-MX` and `es-419` both map to
 * `es`). Falls back to the first supported language when nothing matches.
 */
export function resolveLanguage(
  candidates: readonly string[],
  supported: readonly string[] = SUPPORTED_LANGUAGES,
  fallback: string = SUPPORTED_LANGUAGES[0],
): string {
  for (const tag of candidates) {
    const base = tag?.toLowerCase().split("-")[0];
    if (base && supported.includes(base)) {
      return base;
    }
  }
  return fallback;
}

/** Ordered locale preferences from the host (OS locale in a WKWebview). */
export function detectLanguage(): string {
  if (typeof navigator === "undefined") {
    return SUPPORTED_LANGUAGES[0];
  }
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(
    Boolean,
  );
  return resolveLanguage(candidates);
}
