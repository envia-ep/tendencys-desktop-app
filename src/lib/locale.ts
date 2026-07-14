/** Languages the app ships UI copy for. First entry is the fallback. */
export const SUPPORTED_LANGUAGES = ["en", "es"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

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
