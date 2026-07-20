import assert from "node:assert/strict";
import {
  LANGUAGE_LABELS,
  NUMBER_LOCALES,
  numberLocaleFor,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from "./locale.ts";

// Region subtags are ignored — base language wins.
assert.equal(resolveLanguage(["es-MX", "en-US"]), "es");
assert.equal(resolveLanguage(["es-419"]), "es");
assert.equal(resolveLanguage(["en-GB"]), "en");
assert.equal(resolveLanguage(["pt-BR", "en"]), "pt");
assert.equal(resolveLanguage(["zh-CN"]), "zh");
assert.equal(resolveLanguage(["hi-IN", "en"]), "hi");

// Order matters: first supported match wins.
assert.equal(resolveLanguage(["de-DE", "fr-FR", "es-ES", "en"]), "fr");

// Unsupported-only and empty inputs fall back to the default.
assert.equal(resolveLanguage(["de", "nl"]), "en");
assert.equal(resolveLanguage([]), "en");

// Malformed tags are skipped, not thrown on.
assert.equal(resolveLanguage(["", "es"]), "es");

// Endonyms exist for every supported language.
for (const code of SUPPORTED_LANGUAGES) {
  assert.equal(typeof LANGUAGE_LABELS[code], "string");
  assert.ok(LANGUAGE_LABELS[code].length > 0);
  assert.equal(typeof NUMBER_LOCALES[code], "string");
}
assert.equal(LANGUAGE_LABELS.hi, "हिन्दी");
assert.equal(LANGUAGE_LABELS.zh, "中文");
assert.equal(numberLocaleFor("es-MX"), "es-MX");
assert.equal(numberLocaleFor("pt"), "pt-BR");
assert.equal(numberLocaleFor("unknown"), "en-US");

console.log("locale: ok");
