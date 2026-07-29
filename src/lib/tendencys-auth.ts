import { isTauri } from "./tauri";
import {
  getServiceSiteId,
  getServiceUrl,
  type ServiceDefinition,
} from "@/config/services";
import {
  getEnvironmentMode,
  DEV_ACCOUNTS_BASE_URL,
  DEV_SHELL_SITE_ID,
} from "@/config/environment";

const PROD_TENDENCYS_BASE_URL =
  import.meta.env.VITE_TENDENCYS_BASE_URL ||
  "https://accounts-sandbox.envia.com";

/** Tendencys Desktop site_id (accountsdb / ecartdb). Override via VITE_SHELL_SITE_ID. */
const PROD_SHELL_SITE_ID =
  import.meta.env.VITE_SHELL_SITE_ID || "6a51478d752f0077b7d9b356";

/**
 * Accounts base URL for the active environment mode. Always call this
 * function — never cache the result — so a runtime mode switch (Settings)
 * takes effect immediately everywhere it's read.
 */
export function getTendencysBaseUrl(): string {
  return getEnvironmentMode() === "dev"
    ? DEV_ACCOUNTS_BASE_URL
    : PROD_TENDENCYS_BASE_URL;
}

/** Tendencys Desktop site_id for the active environment mode. */
export function getShellSiteId(): string {
  return getEnvironmentMode() === "dev" ? DEV_SHELL_SITE_ID : PROD_SHELL_SITE_ID;
}

export const DEEP_LINK_SCHEME = "tendencys";

/**
 * Interactive Accounts `/login` or `/signup` URL for the shell.
 * Uses full-page OAuth modes (GSI/Apple popups fail in WKWebView) and a
 * `tendencys://authentication` redirect so the system browser can complete
 * Cloudflare challenges and return via deep link.
 */
export function buildShellAuthUrl(
  authPath: "login" | "signup" = "login",
  email?: string,
): string {
  const redirect = encodeURIComponent(
    btoa(`${DEEP_LINK_SCHEME}://authentication`),
  );
  const emailParam = email ? `&email=${encodeURIComponent(email)}` : "";
  return (
    `${getTendencysBaseUrl()}/${authPath}` +
    `?site_id=${getShellSiteId()}` +
    `&redirect_url=${redirect}` +
    `&google_login_mode=redirection&apple_login_mode=redirection` +
    emailParam
  );
}

/**
 * Accounts clears its browser-side session cookies (`_atid`, `_astfa`,
 * `_atpv`) when the landing page mounts with `?logout=1`. Used before
 * re-opening `/login` for a *different* account: without this, Accounts'
 * axios client auto-attaches the still-valid `_atid` cookie to the login
 * page's background calls and the backend just continues the existing
 * session, silently ignoring the `email` hint and returning the wrong
 * account.
 */
export function buildShellLogoutUrl(): string {
  return `${getTendencysBaseUrl()}/?logout=1`;
}

/** Plain service URL (no shell token). Path defaults to `/`. */
export function buildServiceViewUrl(
  service: ServiceDefinition,
  path = "/",
): string {
  return new URL(path, getServiceUrl(service)).toString();
}

/** Callback URL Accounts will redirect to after login-sites for this service. */
export function buildServiceAuthCallbackUrl(service: ServiceDefinition): string {
  return new URL(service.authCallbackPath, getServiceUrl(service)).toString();
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
  return `${getTendencysBaseUrl()}/login-sites?site_id=${getServiceSiteId(service)}&redirect_url=${redirectUrl}`;
}

export async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
