import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";
import { extractAudience } from "./accounts-api";
import { TENDENCYS_BASE_URL, SHELL_SITE_ID, DEEP_LINK_SCHEME } from "./tendencys-auth";

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
  | { kind: "error"; message: string };

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

export async function hasDeviceKey(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("has_device_key");
  } catch {
    return false;
  }
}

/** Unlink this device locally (keyring + meta) so silent login stops on next launch. */
export async function deleteDeviceKey(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("delete_device_key");
    console.info("[device-key] deleted");
  } catch (error) {
    console.error("[device-key] delete failed:", error);
  }
}

export async function registerDeviceKey(sessionToken: string): Promise<void> {
  if (!isTauri() || !sessionToken) return;
  // Accounts checks the session token's `aud` (= HOSTNAME) against the request
  // Referer; pass the decoded audience so the register POST is not rejected.
  const referer = extractAudience(sessionToken) || TENDENCYS_BASE_URL;
  try {
    await invoke<DeviceKeyMeta>("register_device_key", {
      accountsBaseUrl: TENDENCYS_BASE_URL,
      sessionToken,
      referer,
    });
    console.info("[device-key] registered");
  } catch (error) {
    console.error("[device-key] register failed:", error);
  }
}

/**
 * Attempt silent device-key login. Falls back to interactive SSO when unavailable.
 */
export async function tryDeviceKeyLogin(): Promise<DeviceKeyLoginResult> {
  if (!isTauri()) return { kind: "unavailable" };

  const linked = await hasDeviceKey();
  if (!linked) return { kind: "unavailable" };

  const redirectUrlB64 = btoa(`${DEEP_LINK_SCHEME}://authentication`);

  try {
    const body = await invoke<{
      redirect_url?: string;
      token?: string;
    }>("login_with_device_key", {
      accountsBaseUrl: TENDENCYS_BASE_URL,
      siteId: SHELL_SITE_ID,
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
    console.warn("[device-key] login failed:", message);
    return { kind: "error", message };
  }
}
