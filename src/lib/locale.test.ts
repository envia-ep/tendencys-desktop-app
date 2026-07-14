import assert from "node:assert/strict";
import { resolveLanguage } from "./locale.ts";

// Region subtags are ignored — base language wins.
assert.equal(resolveLanguage(["es-MX", "en-US"]), "es");
assert.equal(resolveLanguage(["es-419"]), "es");
assert.equal(resolveLanguage(["en-GB"]), "en");

// Order matters: first supported match wins.
assert.equal(resolveLanguage(["fr-FR", "es-ES", "en"]), "es");

// Unsupported-only and empty inputs fall back to the default.
assert.equal(resolveLanguage(["fr", "de"]), "en");
assert.equal(resolveLanguage([]), "en");

// Malformed tags are skipped, not thrown on.
assert.equal(resolveLanguage(["", "es"]), "es");

console.log("locale: ok");
