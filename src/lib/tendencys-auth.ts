import { isTauri } from "./tauri";
import type { ServiceDefinition } from "@/config/services";

export const TENDENCYS_BASE_URL =
  import.meta.env.VITE_TENDENCYS_BASE_URL ||
  "https://accounts-sandbox.envia.com";

/** Tendencys Desktop site_id (accountsdb / ecartdb). Override via VITE_SHELL_SITE_ID. */
export const SHELL_SITE_ID =
  import.meta.env.VITE_SHELL_SITE_ID || "6a51478d752f0077b7d9b356";

export const DEEP_LINK_SCHEME = "tendencys";

/** Plain service URL (no shell token). Path defaults to `/`. */
export function buildServiceViewUrl(
  service: ServiceDefinition,
  path = "/",
): string {
  return new URL(path, service.url).toString();
}

/** Callback URL Accounts will redirect to after login-sites for this service. */
export function buildServiceAuthCallbackUrl(service: ServiceDefinition): string {
  return new URL(service.authCallbackPath, service.url).toString();
}

/**
 * Per-service SSO entry using Accounts `/login-sites` (audience-scoped handoff).
 * Returns null for unsupported products (open the plain product URL instead).
 */
export function buildServiceSsoUrl(service: ServiceDefinition): string | null {
  if (service.authMode === "unsupported") {
    return null;
  }

  const redirectUrl = encodeURIComponent(
    btoa(buildServiceAuthCallbackUrl(service)),
  );
  return `${TENDENCYS_BASE_URL}/login-sites?site_id=${service.siteId}&redirect_url=${redirectUrl}`;
}

export async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
