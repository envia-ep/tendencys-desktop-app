import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrappers over the Rust `webview_manager` commands. All native
 * multiwebview IPC lives here so the rest of the app stays engine-agnostic.
 */

export async function selectService(
  serviceId: string,
  url: string,
): Promise<void> {
  await invoke("select_service", { serviceId, url });
}

/**
 * Background-create a hidden product webview and run its SSO handoff so a later
 * rail click is instant. Never changes the active/visible service.
 */
export async function prewarmService(
  serviceId: string,
  url: string,
): Promise<void> {
  await invoke("prewarm_service", { serviceId, url });
}

export async function navigateService(
  serviceId: string,
  url: string,
): Promise<void> {
  await invoke("navigate_service", { serviceId, url });
}

export async function serviceHistoryBack(): Promise<void> {
  await invoke("service_history_back");
}

export async function serviceHistoryForward(): Promise<void> {
  await invoke("service_history_forward");
}

export type ServiceNavigatedEvent = {
  serviceId: string;
  url: string;
  replace: boolean;
};

/** Fires when a product webview navigates (document load or SPA push/replace). */
export async function listenServiceNavigated(
  handler: (event: ServiceNavigatedEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ service_id: string; url: string; replace: boolean }>(
    "service-navigated",
    (event) =>
      handler({
        serviceId: event.payload.service_id,
        url: event.payload.url,
        replace: event.payload.replace,
      }),
  );
}

export async function reloadService(): Promise<void> {
  await invoke("reload_service");
}

export async function setServiceVisible(visible: boolean): Promise<void> {
  await invoke("set_service_visible", { visible });
}

/** Keep the native product webview glued to the collapsible menu's current width. */
export async function setContentLeftInset(leftInset: number): Promise<void> {
  await invoke("set_content_left_inset", { leftInset });
}

export async function openShellLogin(
  accountsBase: string,
  siteId: string,
  redirectB64: string,
  authPath: "login" | "signup" = "login",
): Promise<void> {
  await invoke("open_shell_login", {
    accountsBase,
    siteId,
    redirectB64,
    authPath,
  });
}

export async function closeShellLogin(): Promise<void> {
  await invoke("close_shell_login");
}

export async function logoutWebviews(): Promise<void> {
  await invoke("logout_webviews");
}

/** Write shell session JWT as `_atid` into the shared product WKWebView cookie jar. */
export async function seedAccountsSession(
  accountsBase: string,
  token: string,
): Promise<void> {
  await invoke("seed_accounts_session", { accountsBase, token });
}

/** Remove `_atid` from the shared product WKWebView cookie jar (logout). */
export async function clearAccountsSession(accountsBase: string): Promise<void> {
  await invoke("clear_accounts_session", { accountsBase });
}

/** Read the live `_atid` back from the shared product WKWebView cookie jar (or null). */
export async function readAccountsSession(
  accountsBase: string,
): Promise<string | null> {
  return (
    (await invoke<string | null>("read_accounts_session", { accountsBase })) ??
    null
  );
}

/** Fires when a product webview finishes its first load (payload: service id). */
export async function listenServiceLoaded(
  handler: (serviceId: string) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("service-loaded", (event) => handler(event.payload));
}

/**
 * Fires once the embedded Accounts login/signup page finishes its first load
 * and is visible + interactive. Used to stop the "connecting" timeout instead
 * of guessing a fixed duration that could fire while the user is typing.
 */
export async function listenShellLoginLoaded(
  handler: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("shell-login-loaded", () => handler());
}

export type ShellAuthPayload = {
  /** One-time handoff JWT (aud = tendencys://authentication). */
  token: string;
  /** Real Accounts session cookie (_atid: id + aud) the /login page set, or null. */
  atid: string | null;
};

/** Fires when the in-app Accounts login captures a handoff JWT + the real `_atid`. */
export async function listenShellAuthToken(
  handler: (payload: ShellAuthPayload) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ token: string; atid: string | null }>(
    "shell-auth-token",
    (event) =>
      handler({ token: event.payload.token, atid: event.payload.atid ?? null }),
  );
}

/**
 * Fires (payload: service id) when a product/pre-warm webview falls back to
 * Accounts `/login` (missing `_atid`) or the product's own `/login` (dead session).
 */
export async function listenAuthRequired(
  handler: (serviceId: string) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("auth-required", (event) => handler(event.payload));
}
