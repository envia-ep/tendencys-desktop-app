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

/** Open the OS-native DevTools inspector on the active product webview. */
export async function openActiveServiceDevtools(): Promise<void> {
  await invoke("open_active_service_devtools");
}

export async function setServiceVisible(visible: boolean): Promise<void> {
  await invoke("set_service_visible", { visible });
}

/** Keep the native product webview glued to the collapsible menu's current width. */
export async function setContentLeftInset(leftInset: number): Promise<void> {
  await invoke("set_content_left_inset", { leftInset });
}

export async function logoutWebviews(): Promise<void> {
  await invoke("logout_webviews");
}

/** Open an independent shell window that shares the Accounts session. */
export async function createShellWindow(): Promise<string> {
  const label = await invoke<string>("create_shell_window");
  // Nudge the new shell to hydrate if it raced past an empty store read.
  await emitShellSessionUpdated().catch(() => undefined);
  return label;
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

/**
 * Wipe the ENTIRE shared WKWebView data store (all cookies incl. Accounts
 * `ec_session` + each product session, local storage, caches) on logout, so the
 * next user starts from an empty jar and `/login` cannot auto-redirect as the
 * previous user. Awaits the async wipe's grace window before resolving.
 */
export async function clearSharedWebData(): Promise<void> {
  await invoke("clear_shared_web_data");
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

export type ShellAuthPayload = {
  /** One-time handoff JWT (aud = tendencys://authentication). */
  token: string;
  /** Real Accounts session cookie (_atid: id + aud) the /login page set, or null. */
  atid: string | null;
};

/** Fires when the system-browser deep-link returns a handoff JWT (atid is null). */
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
 * Fires (payload: target id) when the OS opens `tendencys://open/<target>`.
 * Target is a product id (`envia-shipping`) or shell section (`home`, `settings`, …).
 */
export async function listenShellOpen(
  handler: (targetId: string) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("shell-open", (event) => handler(event.payload));
}

/**
 * Fires (payload: service id) when a product webview falls back to Accounts
 * `/login` (missing `_atid`) or the product's own `/login` (dead session).
 */
export async function listenAuthRequired(
  handler: (serviceId: string) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("auth-required", (event) => handler(event.payload));
}

/**
 * Fires (payload: service id) when a product's `/login-sites` SSO handoff
 * lands on an Accounts step-up page (2FA `/verify`, `/accept-terms`,
 * `/phone-verification`, `/verify-device`) instead of the product itself.
 * Deliberately distinct from `listenAuthRequired`: reseeding `_atid` and
 * retrying won't resolve this — the user has to act on the page that's
 * already showing. See `useProductSso`'s handler for the cross-service retry
 * once one of these completes.
 */
export async function listenVerificationRequired(
  handler: (serviceId: string) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("verification-required", (event) =>
    handler(event.payload),
  );
}

/**
 * Broadcast after the shared auth store is cleared so sibling shells drop
 * in-memory session UI (cookies/webviews already wiped by the caller).
 */
export async function emitShellSignedOut(): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("shell-signed-out");
}

/** Fires when another shell fully signed out. */
export async function listenShellSignedOut(
  handler: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("shell-signed-out", () => handler());
}

/**
 * Broadcast after a successful login so sibling shells reload the shared
 * session from the plugin store (handoff JWT is one-time / single-window).
 */
export async function emitShellSessionUpdated(): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("shell-session-updated");
}

export async function listenShellSessionUpdated(
  handler: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("shell-session-updated", () => handler());
}

export type ProductTab = {
  id: string;
  label: string;
  url: string;
  title: string;
  openerServiceId: string;
};

export type ProductTabsChangedEvent = {
  tabs: ProductTab[];
  /** null = primary service surface */
  activeTabId: string | null;
};

/** Aux in-app tabs opened from product window.open / target=_blank. */
export async function listenProductTabsChanged(
  handler: (event: ProductTabsChangedEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{
    tabs: Array<{
      id: string;
      label: string;
      url: string;
      title: string;
      opener_service_id: string;
    }>;
    active_tab_id: string | null;
  }>("product-tabs-changed", (event) =>
    handler({
      tabs: event.payload.tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        url: tab.url,
        title: tab.title,
        openerServiceId: tab.opener_service_id,
      })),
      activeTabId: event.payload.active_tab_id,
    }),
  );
}

/** Focus an aux tab, or pass null to return to the primary service surface. */
export async function focusProductTab(tabId: string | null): Promise<void> {
  await invoke("focus_product_tab", { tabId });
}

export async function closeProductTab(tabId: string): Promise<void> {
  await invoke("close_product_tab", { tabId });
}
