import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";
import { extractAudience } from "./accounts-api";
import { ssoCaptureFailure } from "./sso-log";
import {
  getTendencysBaseUrl,
  getShellSiteId,
  DEEP_LINK_SCHEME,
} from "./tendencys-auth";

export type RegisterDeviceKeyResult =
  | { ok: true }
  | { ok: false; message: string };

/** User-visible copy when `register_device_key` fails after a successful handoff. */
export function registerFailureUserMessage(message: string): string {
  if (message.includes("maximum") && message.includes("linked devices")) {
    return "This account already has the maximum number of linked devices. Unlink an old device in account settings, then sign in again.";
  }
  return "Could not link this computer for silent sign-in. You are signed in, but the next launch may ask you to sign in again.";
}

export type DeviceKeyMeta = {
  deviceId: string;
  publicKey: string;
  platform: string;
  deviceLabel: string;
  methodId?: string | null;
};

export type DeviceKeyLoginResult =
  | {
      kind: "handoff";
      authorization: string;
      /** Real Accounts session token (`_atid`: id + aud) from the login body. */
      sessionToken: string | null;
    }
  | { kind: "intermediate"; redirectUrl: string }
  | { kind: "unavailable" }
  | { kind: "rate_limited"; retryAfterMs: number; message: string }
  | { kind: "error"; message: string };

/** How long a failed silent login is cached so cold-start double-attempts and
 * quick retries don't re-hit `options` + `login`. A 429 uses its `Retry-After`
 * instead (falling back to this) so we never hammer the rate limiter. */
const NEGATIVE_CACHE_MS = 60_000;

function extractAuthorizationFromRedirect(redirectUrl: string): string | null {
  try {
    const url = new URL(redirectUrl);
    const fromQuery = url.searchParams.get("authorization");
    if (fromQuery) return fromQuery;
  } catch {
    // Custom schemes (tendencys://) still parse in modern URL impls; fall through.
  }
  const match = redirectUrl.match(/[?&]authorization=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function hasDeviceKey(accountId: string): Promise<boolean> {
  if (!isTauri() || !accountId) return false;
  try {
    return await invoke<boolean>("has_device_key", { accountId });
  } catch {
    return false;
  }
}

/** Wipe local keyring + meta for one account only (does not touch Accounts).
 * Ordinary logout of that account should call this so the slot cannot remint.
 * Other accounts' keys are left intact. */
export async function deleteDeviceKey(accountId: string): Promise<void> {
  if (!isTauri() || !accountId) return;
  try {
    await invoke("delete_device_key", { accountId });
    console.info("[device-key] deleted locally", accountId);
  } catch (error) {
    console.error("[device-key] delete failed:", error);
  }
}

export async function registerDeviceKey(
  sessionToken: string,
  accountId: string,
): Promise<RegisterDeviceKeyResult> {
  if (!isTauri() || !sessionToken || !accountId) {
    return { ok: true };
  }
  // Accounts checks the session token's `aud` (= HOSTNAME) against the request
  // Referer; pass the decoded audience so the register POST is not rejected.
  const referer = extractAudience(sessionToken) || getTendencysBaseUrl();

  try {
    await invoke<DeviceKeyMeta>("register_device_key", {
      accountId,
      accountsBaseUrl: getTendencysBaseUrl(),
      sessionToken,
      referer,
    });
    console.info("[device-key] registered", accountId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[device-key] register failed:", error);

    const deviceLimit =
      message.includes("maximum") && message.includes("linked devices");
    if (deviceLimit) {
      console.error(
        "[device-key] device limit reached — unlink an old device in account settings",
      );
    }

    // Status/body stay in `message` from Rust (`register failed (422): …`).
    // Never put the session token in Sentry extras.
    ssoCaptureFailure(
      "device-key register failed",
      {
        accountId,
        deviceLimit,
        statusBody: message.slice(0, 500),
      },
      { "device_key.register": "failed" },
    );

    return { ok: false, message: registerFailureUserMessage(message) };
  }
}

/** Rust encodes a 429 as `RATE_LIMITED|<retry-after-seconds>|<body>`. */
function parseRateLimited(message: string): DeviceKeyLoginResult | null {
  if (!message.startsWith("RATE_LIMITED|")) return null;
  const rest = message.slice("RATE_LIMITED|".length);
  const sepIdx = rest.indexOf("|");
  const retryRaw = sepIdx >= 0 ? rest.slice(0, sepIdx) : "";
  const body = sepIdx >= 0 ? rest.slice(sepIdx + 1) : rest;
  const retrySecs = Number.parseInt(retryRaw, 10);
  const retryAfterMs =
    Number.isFinite(retrySecs) && retrySecs > 0
      ? retrySecs * 1000
      : NEGATIVE_CACHE_MS;
  let humanMessage = "Too many attempts. Please try again in a moment.";
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) humanMessage = String(parsed.message);
  } catch {
    // Body is not JSON (e.g. a Cloudflare HTML page) — keep the default copy.
  }
  return { kind: "rate_limited", retryAfterMs, message: humanMessage };
}

async function performDeviceKeyLogin(
  accountId: string,
): Promise<DeviceKeyLoginResult> {
  const linked = await hasDeviceKey(accountId);
  if (!linked) {
    return { kind: "unavailable" };
  }

  const redirectUrlB64 = btoa(`${DEEP_LINK_SCHEME}://authentication`);

  try {
    const body = await invoke<{
      redirect_url?: string;
      token?: string;
    }>("login_with_device_key", {
      accountId,
      accountsBaseUrl: getTendencysBaseUrl(),
      siteId: getShellSiteId(),
      redirectUrlB64,
    });

    const redirectUrl = body.redirect_url;
    if (!redirectUrl) {
      return { kind: "error", message: "Device login returned no redirect." };
    }

    const authorization = extractAuthorizationFromRedirect(redirectUrl);
    if (authorization) {
      return { kind: "handoff", authorization, sessionToken: body.token ?? null };
    }

    // Intermediate Accounts step (terms / phone) — open in shell login webview.
    if (redirectUrl.startsWith("http")) {
      return { kind: "intermediate", redirectUrl };
    }

    return { kind: "error", message: "Device login did not return a handoff token." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rateLimited = parseRateLimited(message);
    if (rateLimited) {
      console.warn("[device-key] login rate-limited; backing off");
      return rateLimited;
    }
    console.warn("[device-key] login failed:", message);
    return { kind: "error", message };
  }
}

let inFlightAccountId: string | null = null;
let inFlight: Promise<DeviceKeyLoginResult> | null = null;
let cachedAccountId: string | null = null;
let cachedResult: DeviceKeyLoginResult | null = null;
let cacheUntil = 0;

/** Clear the coalescing/negative cache — call on logout/account switch so a
 * fresh sign-in is never blocked by a stale failed attempt. */
export function resetDeviceKeyLoginCache(): void {
  inFlight = null;
  inFlightAccountId = null;
  cachedResult = null;
  cachedAccountId = null;
  cacheUntil = 0;
}

/** True while a device-key 429 backoff is still active. */
export function isDeviceKeyRateLimited(): boolean {
  return (
    cachedResult?.kind === "rate_limited" && Date.now() < cacheUntil
  );
}

/**
 * Attempt silent device-key login for a specific Accounts identity.
 *
 * Concurrent callers for the same account share one in-flight request, and a
 * failed attempt is cached briefly so the cold-start double-attempt (remint +
 * LoginPage) and quick retries don't re-hit `options` + `login`. `force` (a
 * user-initiated retry) bypasses the generic-error cache but still honours an
 * active rate-limit backoff.
 */
export async function tryDeviceKeyLogin(
  accountId: string,
  options?: { force?: boolean },
): Promise<DeviceKeyLoginResult> {
  if (!isTauri() || !accountId) return { kind: "unavailable" };

  if (
    cachedResult &&
    cachedAccountId === accountId &&
    Date.now() < cacheUntil
  ) {
    if (cachedResult.kind === "rate_limited" || !options?.force) {
      return cachedResult;
    }
  }

  if (inFlight && inFlightAccountId === accountId) return inFlight;

  inFlightAccountId = accountId;
  inFlight = performDeviceKeyLogin(accountId);
  try {
    const result = await inFlight;
    if (result.kind === "rate_limited") {
      cachedResult = result;
      cachedAccountId = accountId;
      cacheUntil = Date.now() + (result.retryAfterMs || NEGATIVE_CACHE_MS);
    } else if (result.kind === "error") {
      cachedResult = result;
      cachedAccountId = accountId;
      cacheUntil = Date.now() + NEGATIVE_CACHE_MS;
    } else {
      cachedResult = null;
      cachedAccountId = null;
      cacheUntil = 0;
    }
    return result;
  } finally {
    inFlight = null;
    inFlightAccountId = null;
  }
}
