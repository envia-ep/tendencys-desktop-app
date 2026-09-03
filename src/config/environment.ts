import { usePreferencesStore } from "@/stores/preferences-store";
import type { AppEnvironmentMode } from "@/lib/preferences";

/**
 * Runtime environment the shell points at. `production` is prod Accounts
 * (`accounts.envia.com`) plus the in-code product URLs, unless a `VITE_*`
 * override was baked in at build time. `dev` always resolves to the sandbox
 * table below, regardless of what was baked in, so the Settings toggle works
 * identically in any build.
 *
 * Canonical type lives in `@/lib/preferences` (re-exported here) so this
 * module — which reads the live value from the preferences store — stays a
 * one-way dependency on the store instead of a cycle.
 */
export type { AppEnvironmentMode } from "@/lib/preferences";
export { DEFAULT_ENVIRONMENT_MODE } from "@/lib/preferences";

/** Sandbox Accounts host + Envia.com desktop site_id (accountsdb). */
export const DEV_ACCOUNTS_BASE_URL = "https://accounts-sandbox.envia.com";
export const DEV_SHELL_SITE_ID = "6a51478d752f0077b7d9b356";

export type DevServiceOverride = {
  url: string;
  siteId: string;
};

/**
 * Sandbox counterparts for services whose sandbox deployment differs from
 * production, mirrored from the sandbox values already documented in
 * `.env.example`. Services not listed here (Parapaquetes) have no distinct
 * sandbox deployment and keep their production URL/site ID even in Dev mode.
 * Envia Cargo, Envia Returns, Ecart API, and Partners have no
 * sandbox override because they're disabled entirely in Dev mode — see
 * `ServiceDefinition.disabledInDev` in `services.ts`.
 */
export const DEV_SERVICE_OVERRIDES: Record<string, DevServiceOverride> = {
  "envia-shipping": {
    url: "https://shipping-test.envia.com",
    siteId: "646649aa8a157cba800a7fdd",
  },
  "envia-fulfillment": {
    url: "https://fulfillment-test.envia.com",
    siteId: "65315bd5d794a975c9941574",
  },
  "ecart-pay": {
    url: "https://sandbox.ecartpay.com",
    siteId: "60b7f96f4118eb4370469d19",
  },
  "ecart-banking": {
    url: "https://sandbox.ecart.com",
    siteId: "2",
  },
};

/**
 * Current environment mode. Always read fresh at the call site — never cache
 * the result on an object (see `services.ts` resolvers) since the mode can
 * change at runtime via the Settings toggle.
 */
export function getEnvironmentMode(): AppEnvironmentMode {
  return usePreferencesStore.getState().environmentMode;
}
