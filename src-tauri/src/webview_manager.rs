//! Native multi-webview management (Tauri `unstable`).
//!
//! Every call into the experimental multiwebview API is isolated here so a
//! future `unstable` API change is a single-file fix. The shell (main webview)
//! renders chrome; each product and the Accounts login render as child webviews
//! overlaid on the content area, sharing the macOS WKWebView cookie store.
//!
//! Child webview labels:
//! - `svc-<window>--<service_id>` — one per product per shell window,
//!   shown/hidden on menu switch within that window.
//! - `tab-<window>--<n>` — auxiliary in-app tabs from product `window.open`
//!   / `target=_blank` on allowlisted hosts (external hosts → system browser).
//! - Shell windows: `main` (primary) and `shell-N` (additional).
//!
//! Tab chrome lives in the left ServiceMenu (not above the content rect): wry
//! pins child WKWebViews to the window top, so a top inset is unreliable.
//!
//! SSO cookie sharing: the Accounts session cookie `_atid` is a *session* cookie
//! (no `Max-Age`/`Expires`). Session cookies live only in a `WKWebsiteDataStore`
//! instance's memory, so the default per-webview store meant `_atid` set in the
//! `auth` login webview was invisible to the `svc-*` webviews — their
//! `/login-sites` handoff then 401'd and bounced to the interactive login form.
//! Pinning every remote webview to the SAME `data_store_identifier` forces one
//! shared persistent store instance, so `_atid` is visible to every product
//! webview and survives the `auth` webview closing.
//! ponytail: `data_store_identifier` requires macOS 14+/iOS 17+ (no-op elsewhere);
//! `tauri.conf.json` still declares `minimumSystemVersion` 11.0. Upgrade path:
//! bump the minimum to 14.0, or guard this call behind an OS-version check if
//! macOS 11–13 must keep running (older WebKit may crash on this selector).
//!
//! Shell chrome lives in a full-height left column (ServiceMenu). Product
//! webviews use top=0 and only a left inset — wry pins child WKWebViews to the
//! window top (`ViewMinYMargin`), so a top inset cannot be relied on.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use cookie::SameSite;
use tauri::{
    webview::{Cookie, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime, Webview,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

/// When true, shell CloseRequested may destroy the window. Red traffic-light / X
/// leaves this false. Real Quit sets it via [`request_quit`].
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

/// Cap independent shell windows (main + extras) to bound WKWebView memory.
const MAX_SHELL_WINDOWS: usize = 6;
/// Cap auxiliary product tabs per shell window.
const MAX_AUX_TABS: usize = 6;


use crate::desktop_files::{maybe_print_downloaded_label, unique_download_path};

#[derive(Clone, Serialize)]
struct ServiceNavigatedPayload {
    service_id: String,
    url: String,
    replace: bool,
}

/// One auxiliary in-app tab opened from a product new-window request.
#[derive(Clone, Serialize)]
pub(crate) struct ProductTabInfo {
    id: String,
    label: String,
    url: String,
    title: String,
    opener_service_id: String,
}

#[derive(Clone, Serialize)]
struct ProductTabsChangedPayload {
    tabs: Vec<ProductTabInfo>,
    /// `null` = primary service surface; otherwise aux tab id.
    active_tab_id: Option<String>,
}

/// Emitted when shell auth captures a handoff JWT (`token`) and optionally the
/// real Accounts session cookie (`atid`) already in the shared jar. In-app login
/// sets `atid` from `/login`; system-browser deep links leave `atid: None` and
/// the frontend seeds from the authorization API response token instead.
#[derive(Clone, Serialize)]
struct ShellAuthPayload {
    token: String,
    atid: Option<String>,
}

/// Quit the whole process (menu / Cmd+Q / tray). Sets ALLOW_EXIT so close
/// handlers do not hide windows instead of destroying them.
pub fn request_quit(app: &AppHandle) {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Mark exit allowed (ExitRequested path) without calling `app.exit`.
pub fn mark_exit_allowed() {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
}

/// Bring a shell window to the front (deep link, Dock reopen, tray Show,
/// second-instance). Prefers last-focused, then any visible shell, then `main`.
pub fn focus_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    let target = resolve_focus_shell(app);
    if let Some(window) = app.get_window(&target) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    reposition_window(app, &target);
}

fn resolve_focus_shell(app: &AppHandle) -> String {
    let last = app
        .state::<ServiceWebviews>()
        .last_focused
        .lock()
        .unwrap()
        .clone();
    if let Some(label) = last {
        if app.get_window(&label).is_some() {
            return label;
        }
    }
    for label in shell_window_labels(app) {
        if let Some(w) = app.get_window(&label) {
            if w.is_visible().unwrap_or(false) {
                return label;
            }
        }
    }
    if app.get_window(MAIN_WINDOW).is_some() {
        return MAIN_WINDOW.to_string();
    }
    shell_window_labels(app)
        .into_iter()
        .next()
        .unwrap_or_else(|| MAIN_WINDOW.to_string())
}

/// Handle OS deep links: Accounts auth handoff or open a product/section.
///
/// - `tendencys://authentication?authorization=…` → `shell-auth-token`
/// - `tendencys://open/<target>` (product id or shell section) → `shell-open`
pub fn emit_deep_link(app: &AppHandle, urls: &[String]) {
    for raw in urls {
        if let Some(token) = extract_deep_link_authorization(raw) {
            focus_main_window(app);
            let target = resolve_focus_shell(app);
            log::info!("[sso] deep-link shell-auth-token emitted → {target}");
            let _ = app.emit_to(
                shell_target(&target),
                "shell-auth-token",
                ShellAuthPayload {
                    token,
                    atid: None,
                },
            );
            return;
        }
        if let Some(target_id) = extract_deep_link_open_target(raw) {
            focus_main_window(app);
            let target = resolve_focus_shell(app);
            log::info!("[shell] deep-link open target={target_id} → {target}");
            let _ = app.emit_to(shell_target(&target), "shell-open", target_id);
            return;
        }
    }
}

/// Backward-compatible alias used by older call sites / docs.
pub fn emit_deep_link_auth(app: &AppHandle, urls: &[String]) {
    emit_deep_link(app, urls);
}

fn extract_deep_link_authorization(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "tendencys" {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    if host != "authentication" && path != "authentication" {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "authorization")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.is_empty())
}

/// Known open targets — keep in sync with `src/lib/pending-open-target.ts`
/// (`OPEN_SERVICE_IDS` + `OPEN_SHELL_SECTION_IDS`).
const OPEN_TARGET_IDS: &[&str] = &[
    // Products
    "envia-shipping",
    "envia-cargo",
    "envia-fulfillment",
    "envia-returns",
    "parapaquetes",
    "ecart-pay",
    "ecart-banking",
    "ecart-api",
    "tendencys-partners",
    // Shell sections
    "home",
    "developers",
    "settings",
];

/// `tendencys://open/envia-shipping` → `Some("envia-shipping")` when the id is known.
fn extract_deep_link_open_target(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    if url.scheme() != "tendencys" {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    if host != "open" || path.is_empty() {
        return None;
    }
    // Reject nested paths — targets are a single segment.
    if path.contains('/') {
        return None;
    }
    if !OPEN_TARGET_IDS.contains(&path) {
        return None;
    }
    Some(path.to_string())
}

/// Product → shell bridge: save/print + SPA history ping via Tauri IPC.
/// Relies on remote IPC (`capabilities/service-webviews.json`). SPA route
/// changes must NOT use custom-scheme `location.assign` — WebView2 mishandles
/// cancelled custom navigations and causes a constant reload loop on Windows.
const DESKTOP_BRIDGE_SCRIPT: &str = r#"
(function () {
  function invoke(cmd, args) {
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tendencys desktop IPC unavailable'));
  }

  if (!window.__TENDENCYS_DESKTOP__) {
    Object.defineProperty(window, '__TENDENCYS_DESKTOP__', {
      value: Object.freeze({
        isDesktop: true,
        deliver: function (payload) {
          payload = payload || {};
          return invoke('desktop_deliver_file', {
            request: {
              intent: payload.intent || 'save',
              fileName: payload.fileName || payload.file_name || 'label.pdf',
              mime: payload.mime || null,
              dataBase64: payload.dataBase64 || payload.data_base64 || null,
              url: payload.url || null
            }
          });
        }
      }),
      writable: false,
      configurable: false
    });
  }

  if (window.__tendencysShellNav) return;
  window.__tendencysShellNav = true;
  var last = location.href;
  function ping(replace) {
    try {
      var href = location.href;
      if (!replace && href === last) return;
      last = href;
      invoke('desktop_report_nav', { replace: !!replace, url: href }).catch(function () {});
    } catch (e) {}
  }
  var _push = history.pushState;
  history.pushState = function () {
    var ret = _push.apply(this, arguments);
    ping(false);
    return ret;
  };
  var _replace = history.replaceState;
  history.replaceState = function () {
    var ret = _replace.apply(this, arguments);
    ping(true);
    return ret;
  };
  window.addEventListener('popstate', function () { ping(false); });

  if (window.__tendencysOpenPatched) return;
  window.__tendencysOpenPatched = true;
  function openExternalOrTab(url) {
    if (!url || typeof url !== 'string') return;
    invoke('desktop_open_or_tab', { url: url }).catch(function () {});
  }
  function makeOpenStub() {
    var stub = { closed: false, close: function () { this.closed = true; }, focus: function () {}, blur: function () {} };
    var loc = {
      assign: function (v) { openExternalOrTab(String(v)); },
      replace: function (v) { openExternalOrTab(String(v)); },
      toString: function () { return 'about:blank'; }
    };
    Object.defineProperty(loc, 'href', {
      get: function () { return 'about:blank'; },
      set: function (v) { openExternalOrTab(String(v)); },
      configurable: true
    });
    Object.defineProperty(stub, 'location', {
      get: function () { return loc; },
      set: function (v) { openExternalOrTab(String(v)); },
      configurable: true
    });
    return stub;
  }
  var _open = window.open;
  window.open = function (url, target, features) {
    var u = url == null ? '' : String(url);
    if (!u || u === 'about:blank') {
      return makeOpenStub();
    }
    if (/^https?:/i.test(u)) {
      openExternalOrTab(u);
      return makeOpenStub();
    }
    try {
      return _open.call(window, url, target, features);
    } catch (e) {
      return null;
    }
  };
})();
"#;

fn emit_service_navigated<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    service_id: &str,
    url: &str,
    replace: bool,
) {
    app.state::<ServiceWebviews>().with_window_mut(window_label, |state| {
        state.stuck_on_auth.remove(service_id);
    });
    let _ = app.emit_to(
        shell_target(window_label),
        "service-navigated",
        ServiceNavigatedPayload {
            service_id: service_id.to_string(),
            url: url.to_string(),
            replace,
        },
    );
}

/// Product SPA → shell history ping. Invoked from the injected history hook
/// (no navigation). Only accepted from `svc-*` webviews.
#[tauri::command]
pub async fn desktop_report_nav<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    replace: bool,
    url: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let (window_label, service_id) = parse_svc_label(&label).ok_or_else(|| {
        format!("desktop_report_nav only from product webviews, got {label}")
    })?;
    let window_label = window_label.to_string();
    let service_id = service_id.to_string();

    // Same product-vs-Accounts filter as the former tendencys-nav path: Accounts
    // SPA router jumps must not clear stuck auth or enter shell history.
    let is_accounts_or_auth_asset = url
        .parse::<tauri::Url>()
        .map(|parsed| is_accounts_host(&parsed) || is_third_party_auth_asset(&parsed))
        .unwrap_or(true);
    if is_accounts_or_auth_asset {
        return Ok(());
    }
    if let Ok(parsed) = url.parse::<tauri::Url>() {
        if parsed.path() == "/login"
            || parsed.path() == "/login-sites"
            || parsed.path() == "/authentication"
        {
            return Ok(());
        }
    }

    emit_service_navigated(&app, &window_label, &service_id, &url, replace);
    Ok(())
}

fn is_accounts_host(url: &tauri::Url) -> bool {
    url.host_str()
        .map(|h| h.to_ascii_lowercase().contains("accounts"))
        .unwrap_or(false)
}

/// The Accounts `/login` and `/login-sites` pages embed an invisible reCAPTCHA
/// widget, which loads its own iframe navigations (`google.com/recaptcha/...`,
/// `gstatic.com/...`). wry's `on_navigation`/`on_page_load` don't distinguish
/// main-frame vs. subframe navigations, so without this check those iframe
/// loads are misclassified as "the product page navigated", wrongly clearing
/// the auth-required/stuck state while the webview is still parked on the
/// failed Accounts login form.
fn is_third_party_auth_asset(url: &tauri::Url) -> bool {
    url.host_str()
        .map(|h| {
            let h = h.to_ascii_lowercase();
            h.ends_with("google.com") || h.ends_with("gstatic.com") || h.ends_with("recaptcha.net")
        })
        .unwrap_or(false)
}

/// Accounts step-up pages the `/login-sites` SSO handoff can land on when the
/// account still owes a periodic 2FA re-verification, phone verification, or
/// terms acceptance (see `resolvePostLoginRedirect` in the Accounts backend).
/// Every product webview runs its own `/login-sites` handoff independently
/// (on first open + `auth-required` reseed), so without this check each open
/// product silently renders its own copy of the Accounts verification form and
/// gets misreported as a successful "loaded" product — the user then has to
/// complete the same 2FA/terms/phone step separately in every tab. See
/// `emit_verification_required_if_stepup`.
fn is_accounts_step_up(url: &tauri::Url) -> bool {
    is_accounts_host(url)
        && matches!(
            url.path(),
            "/verify" | "/accept-terms" | "/phone-verification" | "/verify-device"
        )
}

/// Emit `verification-required` (deliberately distinct from `auth-required`)
/// when a product's SSO handoff lands on an Accounts step-up page. Unlike
/// `auth-required` — where reseeding `_atid` and retrying `/login-sites` can
/// resolve an expired/invalid session on its own — a step-up page needs the
/// user to act (enter a 2FA code, accept terms, verify a phone). The frontend
/// must not auto-retry *this* webview from under the user; it should wait for
/// this one to navigate away from Accounts, then retry every *other* pending
/// service now that the account-wide requirement is satisfied. Returns true
/// if emitted.
fn emit_verification_required_if_stepup(
    app: &AppHandle,
    window_label: &str,
    service_id: &str,
    url: &tauri::Url,
) -> bool {
    if !is_accounts_step_up(url) {
        return false;
    }
    app.state::<ServiceWebviews>().with_window_mut(window_label, |state| {
        state.stuck_on_auth.insert(service_id.to_string());
    });
    let _ = app.emit_to(shell_target(window_label), "verification-required", service_id);
    true
}

/// Envia Shipping relays the Accounts handoff through a `/login?page=...&t=<jwt>`
/// hop before landing on the real product page: Accounts `/login-sites` ->
/// `ship.envia.com/authentication` (repo `envia`) sets its session then 302s to
/// `shipping.envia.com/login?...&t=<temporal jwt>` (repo `envia-clients`, whose
/// `/login` is a server route that exchanges `t` and 302s onward). That `/login`
/// is a normal mid-flight redirect, NOT a dead session — and it uniquely carries
/// a `t` query param, which a genuine session-expired `/login` never has. Without
/// this exception the desktop treats the hop as an SSO failure and restarts the
/// whole chain on every visit.
fn is_temporal_token_relay(url: &tauri::Url) -> bool {
    url.path() == "/login" && url.query_pairs().any(|(k, _)| k == "t")
}

/// Decode a JWT payload WITHOUT verifying the signature and return its claim
/// shape: `(has_id, aud, exp)`. Used only for diagnostics — never exposes the
/// token value. Returns None when the token cannot be decoded.
fn decode_token_shape(token: &str) -> Option<(bool, Option<String>, Option<i64>)> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload_b64 = parts.next()?;
    let bytes = URL_SAFE_NO_PAD.decode(payload_b64.trim()).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let has_id = json.get("id").map(|v| !v.is_null()).unwrap_or(false);
    let aud = json
        .get("aud")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let exp = json.get("exp").and_then(|v| v.as_i64());
    Some((has_id, aud, exp))
}

/// Log a token's claim shape under the `[sso]` prefix. NEVER logs the raw token:
/// only whether it carries a valid `id` (required by Accounts `/api/login/sites`),
/// its `aud`, `exp`, and length. `hasId=false` reproduces the silent-SSO bug.
fn log_token_shape(context: &str, token: &str) {
    match decode_token_shape(token) {
        Some((has_id, aud, exp)) => {
            log::info!(
                "[sso] {context} token hasId={has_id} aud={aud:?} exp={exp:?} len={}",
                token.len()
            );
        }
        None => log::info!("[sso] {context} token undecodable len={}", token.len()),
    }
}

/// Left inset is dynamic — the collapsible service menu is either the collapsed
/// icon rail or the expanded icon+label list — and is pushed from the frontend
/// via `set_content_left_inset`. Default must match the menu's initial
/// (expanded) state in `src/config/layout.ts` (`MENU_EXPANDED_WIDTH`).
const DEFAULT_LEFT_INSET: f64 = 220.0;

/// Hidden webview that owns the shared data store long enough to seed `_atid`
/// on cold restore (before any product `svc-*` webview exists).
const ATID_SEED_LABEL: &str = "atid-seed";
const SVC_PREFIX: &str = "svc-";
const TAB_PREFIX: &str = "tab-";
/// Separates window label from service id / tab id inside a child label.
const SVC_SEP: &str = "--";
const MAIN_WINDOW: &str = "main";
const SHELL_PREFIX: &str = "shell-";

/// Shared WKWebView data store so every `svc-*` webview sees the same cookie
/// jar (notably the `_atid` session cookie that drives `/login-sites` SSO).
/// Fixed bytes = "TendencysDesktop" so the store is stable across launches.
const SHARED_DATA_STORE: [u8; 16] = *b"TendencysDesktop";

/// Shell webviews only — never remote product webviews.
fn shell_target(window_label: &str) -> EventTarget {
    EventTarget::labeled(window_label.to_string())
}

fn is_shell_window_label(label: &str) -> bool {
    label == MAIN_WINDOW || label.starts_with(SHELL_PREFIX)
}

fn shell_window_labels<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.windows()
        .into_keys()
        .filter(|l| is_shell_window_label(l))
        .collect()
}

fn count_shell_windows<R: Runtime>(app: &AppHandle<R>) -> usize {
    shell_window_labels(app).len()
}

/// Product child label for a shell window: `svc-<window>--<service_id>`.
fn svc_label(window_label: &str, service_id: &str) -> String {
    format!("{SVC_PREFIX}{window_label}{SVC_SEP}{service_id}")
}

fn svc_prefix_for_window(window_label: &str) -> String {
    format!("{SVC_PREFIX}{window_label}{SVC_SEP}")
}

/// Parse `svc-<window>--<service_id>` → `(window, service_id)`.
fn parse_svc_label(label: &str) -> Option<(&str, &str)> {
    let rest = label.strip_prefix(SVC_PREFIX)?;
    let (window, service) = rest.split_once(SVC_SEP)?;
    if window.is_empty() || service.is_empty() {
        return None;
    }
    Some((window, service))
}

fn tab_label(window_label: &str, tab_id: &str) -> String {
    format!("{TAB_PREFIX}{window_label}{SVC_SEP}{tab_id}")
}

fn tab_prefix_for_window(window_label: &str) -> String {
    format!("{TAB_PREFIX}{window_label}{SVC_SEP}")
}

/// Parse `tab-<window>--<tab_id>` → `(window, tab_id)`.
fn parse_tab_label(label: &str) -> Option<(&str, &str)> {
    let rest = label.strip_prefix(TAB_PREFIX)?;
    let (window, tab_id) = rest.split_once(SVC_SEP)?;
    if window.is_empty() || tab_id.is_empty() {
        return None;
    }
    Some((window, tab_id))
}

/// Hosts allowed as in-app tabs (mirror `capabilities/service-webviews.json` + Accounts).
fn is_product_tab_host(url: &tauri::Url) -> bool {
    let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    const EXACT: &[&str] = &[
        "parapaquetes.com",
        "partners.tendencys.com",
        "accounts.envia.com",
        "accounts.ecart.com",
        "accounts-sandbox.envia.com",
        "ship.envia.com",
    ];
    if EXACT.iter().any(|h| host == *h) {
        return true;
    }
    const SUFFIXES: &[&str] = &[
        ".envia.com",
        ".ecart.com",
        ".ecartapi.com",
        ".ecartpay.com",
        ".parapaquetes.com",
        ".tendencys.com",
    ];
    SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
}

fn title_from_url(url: &tauri::Url) -> String {
    url.host_str()
        .map(|h| h.to_string())
        .unwrap_or_else(|| "Page".into())
}

/// Calling shell label from an invoke originating in that shell's webview.
fn caller_shell_label(webview: &Webview) -> Result<String, String> {
    let label = webview.label().to_string();
    if !is_shell_window_label(&label) {
        return Err(format!("command requires a shell webview, got {label}"));
    }
    Ok(label)
}

/// Per-shell active service, menu inset, aux tabs, and auth-stuck set.
pub struct WindowShellState {
    pub active: Option<String>,
    pub left_inset: f64,
    /// service_ids parked on an Accounts fallback / step-up page in this window.
    pub stuck_on_auth: HashSet<String>,
    pub tabs: Vec<ProductTabInfo>,
    pub next_tab_seq: u32,
    /// When set, that aux tab webview is shown instead of the active service.
    pub active_tab_id: Option<String>,
}

impl WindowShellState {
    fn new() -> Self {
        Self {
            active: None,
            left_inset: DEFAULT_LEFT_INSET,
            stuck_on_auth: HashSet::new(),
            tabs: Vec::new(),
            next_tab_seq: 1,
            active_tab_id: None,
        }
    }
}

/// Tracks per-window product webview state for independent shells.
pub struct ServiceWebviews {
    pub by_window: Mutex<HashMap<String, WindowShellState>>,
    pub last_focused: Mutex<Option<String>>,
}

impl Default for ServiceWebviews {
    fn default() -> Self {
        let mut by_window = HashMap::new();
        by_window.insert(MAIN_WINDOW.to_string(), WindowShellState::new());
        Self {
            by_window: Mutex::new(by_window),
            last_focused: Mutex::new(Some(MAIN_WINDOW.to_string())),
        }
    }
}

impl ServiceWebviews {
    fn with_window_mut<F, T>(&self, window_label: &str, f: F) -> T
    where
        F: FnOnce(&mut WindowShellState) -> T,
    {
        let mut map = self.by_window.lock().unwrap();
        let state = map
            .entry(window_label.to_string())
            .or_insert_with(WindowShellState::new);
        f(state)
    }

    fn remove_window(&self, window_label: &str) {
        self.by_window.lock().unwrap().remove(window_label);
        let mut last = self.last_focused.lock().unwrap();
        if last.as_deref() == Some(window_label) {
            *last = None;
        }
    }
}

/// Content rect (physical px) to the right of the left chrome column.
/// Top is always 0 — shell chrome is full-height on the left, not a top bar.
fn content_rect<R: Runtime>(
    window: &tauri::Window<R>,
    left_inset: f64,
) -> tauri::Result<(PhysicalPosition<f64>, PhysicalSize<f64>)> {
    let scale = window.scale_factor()?;
    let phys = window.inner_size()?;
    let left = left_inset * scale;
    let w = (phys.width as f64 - left).max(0.0);
    let h = phys.height as f64;
    Ok((PhysicalPosition::new(left, 0.0), PhysicalSize::new(w, h)))
}

/// Reposition product + aux-tab children of one shell window.
pub fn reposition_window<R: Runtime>(app: &AppHandle<R>, window_label: &str) {
    let Some(window) = app.get_window(window_label) else {
        return;
    };
    let left_inset = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| s.left_inset);
    let svc_prefix = svc_prefix_for_window(window_label);
    let tab_prefix = tab_prefix_for_window(window_label);
    if let Ok((pos, size)) = content_rect(&window, left_inset) {
        for (label, webview) in app.webviews() {
            if label.starts_with(&svc_prefix) || label.starts_with(&tab_prefix) {
                let _ = webview.set_position(pos);
                let _ = webview.set_size(size);
            }
        }
    }
}

/// Reposition product children of every shell window.
#[allow(dead_code)] // kept for tray/Dock paths that restore multiple shells
pub fn reposition_all<R: Runtime>(app: &AppHandle<R>) {
    for label in shell_window_labels(app) {
        reposition_window(app, &label);
    }
}

/// Close every product + aux-tab child belonging to a shell window and drop its state.
fn destroy_shell_children(app: &AppHandle, window_label: &str) {
    let svc_prefix = svc_prefix_for_window(window_label);
    let tab_prefix = tab_prefix_for_window(window_label);
    for (label, webview) in app.webviews() {
        if label.starts_with(&svc_prefix) || label.starts_with(&tab_prefix) {
            let _ = webview.close();
        }
    }
    app.state::<ServiceWebviews>().remove_window(window_label);
}

fn emit_product_tabs_changed(app: &AppHandle, window_label: &str) {
    let payload = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        ProductTabsChangedPayload {
            tabs: s.tabs.clone(),
            active_tab_id: s.active_tab_id.clone(),
        }
    });
    let _ = app.emit_to(shell_target(window_label), "product-tabs-changed", payload);
}

fn hide_window_product_children(app: &AppHandle, window_label: &str, except: Option<&str>) {
    let svc_prefix = svc_prefix_for_window(window_label);
    let tab_prefix = tab_prefix_for_window(window_label);
    for (label, child) in app.webviews() {
        if (label.starts_with(&svc_prefix) || label.starts_with(&tab_prefix))
            && except != Some(label.as_str())
        {
            let _ = child.hide();
        }
    }
}

fn close_all_aux_tabs_for_window(app: &AppHandle, window_label: &str) {
    let labels: Vec<String> = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| {
            let labels = s.tabs.iter().map(|t| t.label.clone()).collect();
            s.tabs.clear();
            s.active_tab_id = None;
            labels
        });
    for label in labels {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.close();
        }
    }
    emit_product_tabs_changed(app, window_label);
}

/// Open allowlisted http(s) in an in-app tab; otherwise system browser.
fn handle_new_window_url(
    app: &AppHandle,
    window_label: &str,
    opener_service_id: &str,
    url: &tauri::Url,
) {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("");
    let allowlisted = is_product_tab_host(url);
    log::info!(
        "[product-tabs] new-window scheme={scheme} url={url} opener={opener_service_id}"
    );
    if scheme != "http" && scheme != "https" {
        return;
    }
    if allowlisted {
        match open_product_tab(app, window_label, opener_service_id, url) {
            Ok(()) => {}
            Err(err) => {
                log::warn!("[product-tabs] open_product_tab failed: {err}");
            }
        }
        return;
    }
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        log::warn!("[product-tabs] open_url failed for {url}: {err}");
    }
}

fn open_product_tab(
    app: &AppHandle,
    window_label: &str,
    opener_service_id: &str,
    url: &tauri::Url,
) -> Result<(), String> {
    // Reuse an existing tab with the same URL.
    let existing = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        s.tabs
            .iter()
            .find(|t| t.url == url.as_str())
            .map(|t| t.id.clone())
    });
    if let Some(tab_id) = existing {
        return focus_product_tab_inner(app, window_label, Some(&tab_id));
    }

    let tab_count = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| s.tabs.len());
    if tab_count >= MAX_AUX_TABS {
        return Err("maximum number of tabs reached".into());
    }

    let window = app
        .get_window(window_label)
        .ok_or_else(|| format!("shell window not found: {window_label}"))?;

    let (tab_id, label) = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        let id = s.next_tab_seq.to_string();
        s.next_tab_seq = s.next_tab_seq.saturating_add(1);
        let label = tab_label(window_label, &id);
        (id, label)
    });

    build_tab_webview(
        app,
        &window,
        window_label,
        &label,
        &tab_id,
        opener_service_id,
        url.as_str(),
    )?;

    let info = ProductTabInfo {
        id: tab_id.clone(),
        label: label.clone(),
        url: url.to_string(),
        title: title_from_url(url),
        opener_service_id: opener_service_id.to_string(),
    };
    app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        s.tabs.push(info);
        s.active_tab_id = Some(tab_id.clone());
    });

    hide_window_product_children(app, window_label, Some(&label));
    if let Some(child) = app.get_webview(&label) {
        let _ = child.show();
    }
    emit_product_tabs_changed(app, window_label);
    log::info!("[product-tabs] opened tab={tab_id} label={label}");
    Ok(())
}

fn focus_product_tab_inner(
    app: &AppHandle,
    window_label: &str,
    tab_id: Option<&str>,
) -> Result<(), String> {
    let window = app
        .get_window(window_label)
        .ok_or_else(|| format!("shell window not found: {window_label}"))?;
    let left_inset = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| s.left_inset);

    if let Some(id) = tab_id {
        let label = app
            .state::<ServiceWebviews>()
            .with_window_mut(window_label, |s| {
                if !s.tabs.iter().any(|t| t.id == id) {
                    return None;
                }
                s.active_tab_id = Some(id.to_string());
                Some(tab_label(window_label, id))
            })
            .ok_or_else(|| format!("tab not found: {id}"))?;
        hide_window_product_children(app, window_label, Some(&label));
        if let Some(child) = app.get_webview(&label) {
            if let Ok((pos, size)) = content_rect(&window, left_inset) {
                let _ = child.set_position(pos);
                let _ = child.set_size(size);
            }
            let _ = child.show();
        }
        emit_product_tabs_changed(app, window_label);
        return Ok(());
    }

    // Focus primary service surface.
    let active = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        s.active_tab_id = None;
        s.active.clone()
    });
    let except = active
        .as_ref()
        .map(|svc| svc_label(window_label, svc));
    hide_window_product_children(app, window_label, except.as_deref());
    if let Some(svc) = active {
        if let Some(child) = app.get_webview(&svc_label(window_label, &svc)) {
            if let Ok((pos, size)) = content_rect(&window, left_inset) {
                let _ = child.set_position(pos);
                let _ = child.set_size(size);
            }
            let _ = child.show();
        }
    }
    emit_product_tabs_changed(app, window_label);
    Ok(())
}

fn close_product_tab_inner(
    app: &AppHandle,
    window_label: &str,
    tab_id: &str,
) -> Result<(), String> {
    let label = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        let idx = s.tabs.iter().position(|t| t.id == tab_id)?;
        let removed = s.tabs.remove(idx);
        if s.active_tab_id.as_deref() == Some(tab_id) {
            s.active_tab_id = None;
        }
        Some(removed.label)
    });
    let Some(label) = label else {
        return Err(format!("tab not found: {tab_id}"));
    };
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    // Return to primary service (or keep another tab if we later change policy).
    focus_product_tab_inner(app, window_label, None)?;
    Ok(())
}

/// Resolve opener service id from the calling product or tab webview label.
fn opener_service_from_label(app: &AppHandle, label: &str) -> Option<(String, String)> {
    if let Some((window, service)) = parse_svc_label(label) {
        return Some((window.to_string(), service.to_string()));
    }
    if let Some((window, tab_id)) = parse_tab_label(label) {
        let opener = app.state::<ServiceWebviews>().with_window_mut(window, |s| {
            s.tabs
                .iter()
                .find(|t| t.id == tab_id)
                .map(|t| t.opener_service_id.clone())
        })?;
        return Some((window.to_string(), opener));
    }
    None
}

/// Wire resize / focus / close for a shell window (main or shell-N).
pub fn attach_shell_window_events(app: &AppHandle, window_label: &str) {
    let Some(window) = app.get_window(window_label) else {
        return;
    };
    let handle = app.clone();
    let label = window_label.to_string();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if ALLOW_EXIT.load(Ordering::SeqCst) {
                return;
            }
            if count_shell_windows(&handle) <= 1 {
                if let Some(w) = handle.get_window(&label) {
                    let _ = w.hide();
                }
                api.prevent_close();
            } else {
                destroy_shell_children(&handle, &label);
            }
        }
        tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            reposition_window(&handle, &label);
        }
        tauri::WindowEvent::Focused(true) => {
            *handle.state::<ServiceWebviews>().last_focused.lock().unwrap() =
                Some(label.clone());
        }
        _ => {}
    });
}

fn next_shell_label(app: &AppHandle) -> Result<String, String> {
    for n in 2..=MAX_SHELL_WINDOWS + 1 {
        let label = format!("{SHELL_PREFIX}{n}");
        if app.get_window(&label).is_none() {
            return Ok(label);
        }
    }
    Err("maximum number of windows reached".into())
}

/// Open an independent shell window sharing the same Accounts session.
#[tauri::command]
pub async fn create_shell_window(app: AppHandle) -> Result<String, String> {
    if count_shell_windows(&app) >= MAX_SHELL_WINDOWS {
        return Err("maximum number of windows reached".into());
    }
    let label = next_shell_label(&app)?;
    app.state::<ServiceWebviews>()
        .with_window_mut(&label, |_| ());

    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Envia.com")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1024.0, 768.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    attach_shell_window_events(&app, &label);
    *app.state::<ServiceWebviews>().last_focused.lock().unwrap() = Some(label.clone());
    let _ = built.set_focus();
    log::info!("[shell] created window {label}");
    Ok(label)
}

/// Create a hidden product webview glued to the content area. The webview stays
/// hidden until `on_page_load(Finished)` and only reveals itself when it is the
/// active service, so a mid-load webview never flashes a blank native rect.
/// A fallback to the interactive Accounts `/login` form (expired shared session)
/// emits `auth-required` so the caller can reveal a stuck hidden webview.
fn build_service_webview(
    app: &AppHandle,
    window: &tauri::Window,
    window_label: &str,
    label: &str,
    service_id: &str,
    url: &str,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let left_inset = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| s.left_inset);
    let (pos, size) = content_rect(window, left_inset).map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let id_for_nav = service_id.to_string();
    let win_for_nav = window_label.to_string();
    let app_for_load = app.clone();
    let id_for_load = service_id.to_string();
    let win_for_load = window_label.to_string();

    // `_atid` is committed to the shared cookie store before this webview
    // exists, but is not reliably visible via `document.cookie` on the
    // Accounts page that needs it. Hand it over explicitly so the SSO
    // handoff (`/login-sites`) can read it from its own JS context.
    let atid_script = parsed
        .host_str()
        .filter(|_| is_accounts_host(&parsed))
        .and_then(|host| fetch_atid_value(app, host).map(|token| (host.to_string(), token)))
        .map(|(host, token)| atid_bootstrap_script(&host, &token));

    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_store_identifier(SHARED_DATA_STORE)
        .initialization_script(DESKTOP_BRIDGE_SCRIPT);
    if let Some(script) = &atid_script {
        builder = builder.initialization_script(script);
    }
    let app_for_new_window = app.clone();
    let win_for_new_window = window_label.to_string();
    let opener_for_new_window = service_id.to_string();
    let app_for_download = app.clone();
    let service_id_for_download = service_id.to_string();
    let builder = builder
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    // WebKit already fills `destination` with its suggested
                    // filename (Content-Disposition). Prefer that over the URL
                    // path, which is often empty for blob:/API downloads.
                    let from_webkit = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .filter(|s| {
                            !s.is_empty()
                                && !s.eq_ignore_ascii_case("unknown")
                                && !s.eq_ignore_ascii_case("download.bin")
                        })
                        .map(|s| s.to_string());
                    let from_url = url
                        .path_segments()
                        .and_then(|mut s| s.next_back())
                        .filter(|s| !s.is_empty() && !s.contains('='))
                        .map(|s| s.to_string());
                    let suggested = from_webkit
                        .or(from_url)
                        .unwrap_or_else(|| "label.pdf".into());
                    *destination = unique_download_path(&suggested);
                    log::info!(
                        "[desktop-files] download requested → {}",
                        destination.display()
                    );
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    log::info!(
                        "[desktop-files] download finished success={success} url={url} path={:?}",
                        path.as_ref().map(|p| p.display().to_string())
                    );
                    if success {
                        if let Some(path) = path.as_ref() {
                            if let Err(e) = maybe_print_downloaded_label(
                                &app_for_download,
                                &service_id_for_download,
                                path,
                            ) {
                                log::warn!(
                                    "[desktop-files] print after download failed: {e}"
                                );
                            }
                        }
                    }
                    true
                }
                _ => true,
            }
        })
        .on_new_window(move |url, _features| {
            handle_new_window_url(
                &app_for_new_window,
                &win_for_new_window,
                &opener_for_new_window,
                &url,
            );
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            // login-sites falls back to the interactive form when the shared
            // `_atid` is missing/expired. Surface it so the webview can be
            // revealed for one re-auth instead of silently stuck on a form.
            // Product `/login` (except Shipping's mid-handoff token relay) is the
            // same class of failure.
            if emit_auth_required_if_login(&app_for_nav, &win_for_nav, &id_for_nav, url) {
                return true;
            }

            // Same class of "not actually loaded" fallback as the check above,
            // but for a pending 2FA/terms/phone step-up rather than a dead
            // session — see `emit_verification_required_if_stepup`.
            if emit_verification_required_if_stepup(&app_for_nav, &win_for_nav, &id_for_nav, url)
            {
                return true;
            }

            // Document navigations on product hosts (skip Accounts SSO hops,
            // auth callbacks, and third-party auth widget assets like reCAPTCHA).
            if !is_accounts_host(url)
                && !is_third_party_auth_asset(url)
                && url.path() != "/login-sites"
                && url.path() != "/authentication"
                && (url.scheme() == "https" || url.scheme() == "http")
            {
                emit_service_navigated(
                    &app_for_nav,
                    &win_for_nav,
                    &id_for_nav,
                    &url.to_string(),
                    false,
                );
            }
            true
        })
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let loaded_url = payload.url();
            // Catch product `/login` on finished load too (some redirects skip
            // on_navigation for the final document).
            let auth_required =
                emit_auth_required_if_login(&app_for_load, &win_for_load, &id_for_load, loaded_url);
            let verification_required = emit_verification_required_if_stepup(
                &app_for_load,
                &win_for_load,
                &id_for_load,
                loaded_url,
            );
            // The `/login-sites` relay page itself finishes loading (the "Accessing…"
            // spinner) before its client-side XHR to `/api/login/sites` resolves and
            // (on failure) redirects to `/login`. Treat it the same as the `/login`
            // fallback for "loaded" purposes so the reseed-retry guard isn't cleared
            // on this transient intermediate page.
            let is_sso_relay = is_accounts_host(loaded_url) && loaded_url.path() == "/login-sites";
            // Shipping (and similar) land on `/authentication` before the
            // temporal-token hop — not a finished product load.
            let is_auth_callback = loaded_url.path() == "/authentication";
            if !is_accounts_host(loaded_url)
                && !is_third_party_auth_asset(loaded_url)
                && loaded_url.path() != "/login-sites"
                && loaded_url.path() != "/login"
                && !is_auth_callback
                && (loaded_url.scheme() == "https" || loaded_url.scheme() == "http")
            {
                emit_service_navigated(
                    &app_for_load,
                    &win_for_load,
                    &id_for_load,
                    &loaded_url.to_string(),
                    false,
                );
            }
            let (active, active_tab) = app_for_load
                .state::<ServiceWebviews>()
                .with_window_mut(&win_for_load, |s| {
                    (s.active.clone(), s.active_tab_id.clone())
                });
            // Only reveal when this service is active and no aux tab is focused.
            if active_tab.is_none() && active.as_deref() == Some(id_for_load.as_str()) {
                let _ = webview.show();
            }
            // Do not report "loaded" for the auth-required fallback page, a
            // pending verification step-up page, the `/login-sites` relay
            // spinner, or product `/authentication` mid-handoff — otherwise
            // any of these clears the reseed-retry guard (or, for step-up,
            // gets mistaken for the product itself) as if the product had
            // actually loaded.
            if !auth_required && !verification_required && !is_sso_relay && !is_auth_callback {
                let _ = app_for_load.emit_to(
                    shell_target(&win_for_load),
                    "service-loaded",
                    &id_for_load,
                );
            }
        });

    let webview = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    // Hidden until on_page_load(Finished) reveals it (only if active).
    let _ = webview.hide();
    Ok(())
}

/// Auxiliary in-app tab webview (product popup / target=_blank on allowlisted hosts).
fn build_tab_webview(
    app: &AppHandle,
    window: &tauri::Window,
    window_label: &str,
    label: &str,
    tab_id: &str,
    opener_service_id: &str,
    url: &str,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let left_inset = app
        .state::<ServiceWebviews>()
        .with_window_mut(window_label, |s| s.left_inset);
    let (pos, size) = content_rect(window, left_inset).map_err(|e| e.to_string())?;

    let app_for_new_window = app.clone();
    let win_for_new_window = window_label.to_string();
    let opener_for_new_window = opener_service_id.to_string();
    let app_for_load = app.clone();
    let win_for_load = window_label.to_string();
    let tab_id_for_load = tab_id.to_string();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_store_identifier(SHARED_DATA_STORE)
        .initialization_script(DESKTOP_BRIDGE_SCRIPT)
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let from_webkit = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .filter(|s| {
                            !s.is_empty()
                                && !s.eq_ignore_ascii_case("unknown")
                                && !s.eq_ignore_ascii_case("download.bin")
                        })
                        .map(|s| s.to_string());
                    let from_url = url
                        .path_segments()
                        .and_then(|mut s| s.next_back())
                        .filter(|s| !s.is_empty() && !s.contains('='))
                        .map(|s| s.to_string());
                    let suggested = from_webkit
                        .or(from_url)
                        .unwrap_or_else(|| "download.bin".into());
                    *destination = unique_download_path(&suggested);
                    true
                }
                _ => true,
            }
        })
        .on_new_window(move |nav_url, _features| {
            handle_new_window_url(
                &app_for_new_window,
                &win_for_new_window,
                &opener_for_new_window,
                &nav_url,
            );
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let loaded = payload.url();
            let title = title_from_url(loaded);
            let url_str = loaded.to_string();
            app_for_load
                .state::<ServiceWebviews>()
                .with_window_mut(&win_for_load, |s| {
                    if let Some(tab) = s.tabs.iter_mut().find(|t| t.id == tab_id_for_load) {
                        tab.url = url_str.clone();
                        tab.title = title.clone();
                    }
                });
            emit_product_tabs_changed(&app_for_load, &win_for_load);
            let active_tab = app_for_load
                .state::<ServiceWebviews>()
                .with_window_mut(&win_for_load, |s| s.active_tab_id.clone());
            if active_tab.as_deref() == Some(tab_id_for_load.as_str()) {
                let _ = webview.show();
            }
        });

    let webview = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    let _ = webview.hide();
    Ok(())
}

/// Read `_atid` straight out of the shared WKHTTPCookieStore. Used to hand the
/// value to a fresh product webview via `document.cookie` (see
/// `atid_bootstrap_script`) — native `set_cookie` alone is committed to the
/// store but has proven unreliable for JS `document.cookie` visibility on the
/// very page that needs to read it.
fn fetch_atid_value(app: &AppHandle, host: &str) -> Option<String> {
    let webview = find_shared_store_webview(app)?;
    let probe: tauri::Url = format!("https://{host}/").parse().ok()?;
    let jar = webview.cookies_for_url(probe).unwrap_or_default();
    let value = jar
        .into_iter()
        .find(|c| c.name() == "_atid" && !c.value().is_empty())
        .map(|c| c.value().to_string());
    value
}

/// Build a one-shot init script that writes `_atid` into `document.cookie`
/// for `accounts_host` pages, guarded so it never runs on any other origin.
/// Runs at document-start (before the page's own SSO script reads cookies),
/// unlike `set_cookie`, which is committed to the shared data store but is
/// not reliably visible to `document.cookie` in the loading page itself.
fn atid_bootstrap_script(accounts_host: &str, token: &str) -> String {
    format!(
        r#"(function () {{
  if (location.hostname !== {host:?}) return;
  if (document.cookie.split(';').some(function (c) {{ return c.trim().indexOf('_atid=') === 0; }})) return;
  document.cookie = '_atid=' + {token:?} + '; path=/; secure';
}})();"#,
        host = accounts_host,
        token = token,
    )
}

/// Find any existing webview pinned to SHARED_DATA_STORE (seed / svc-*).
fn find_shared_store_webview(app: &AppHandle) -> Option<tauri::Webview> {
    if let Some(existing) = app.get_webview(ATID_SEED_LABEL) {
        return Some(existing);
    }
    app.webviews()
        .into_iter()
        .find(|(label, _)| label.starts_with(SVC_PREFIX) || label.starts_with(TAB_PREFIX))
        .map(|(_, wv)| wv)
}

/// Find or create a hidden webview on SHARED_DATA_STORE for cookie jar ops.
fn shared_store_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    if let Some(existing) = find_shared_store_webview(app) {
        return Ok(existing);
    }
    let host_label = resolve_focus_shell(app);
    let window = app
        .get_window(&host_label)
        .ok_or_else(|| format!("shell window not found: {host_label}"))?;
    let (pos, size) = content_rect(&window, DEFAULT_LEFT_INSET).map_err(|e| e.to_string())?;
    let blank: tauri::Url = "about:blank".parse().map_err(|e| format!("{e}"))?;
    let builder = WebviewBuilder::new(ATID_SEED_LABEL, WebviewUrl::External(blank))
        .data_store_identifier(SHARED_DATA_STORE);
    let created = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    let _ = created.hide();
    Ok(created)
}

/// Emit `auth-required` when the URL is Accounts `/login` or a product `/login`
/// that is not Shipping's mid-handoff token relay. Returns true if emitted.
fn emit_auth_required_if_login(
    app: &AppHandle,
    window_label: &str,
    service_id: &str,
    url: &tauri::Url,
) -> bool {
    let is_accounts_login = is_accounts_host(url) && url.path() == "/login";
    let is_product_login = !is_accounts_host(url)
        && url.path() == "/login"
        && !is_temporal_token_relay(url);
    if is_accounts_login || is_product_login {
        app.state::<ServiceWebviews>().with_window_mut(window_label, |state| {
            state.stuck_on_auth.insert(service_id.to_string());
        });
        let _ = app.emit_to(shell_target(window_label), "auth-required", service_id);
        return true;
    }
    false
}

/// Write the shell's Accounts session JWT into the shared WKWebView cookie jar as
/// `_atid`. Cold restore keeps the shell profile in the store plugin but session
/// cookies do not survive app quit — without this, `/login-sites` 401s and the
/// product webview sits on Accounts' white "Accessing…" spinner.
#[tauri::command]
pub async fn seed_accounts_session(
    app: AppHandle,
    accounts_base: String,
    token: String,
) -> Result<(), String> {
    if token.is_empty() {
        return Err("empty session token".into());
    }
    let base = accounts_base.trim_end_matches('/');
    let accounts_url: tauri::Url = base
        .parse()
        .map_err(|e| format!("invalid accounts url: {e}"))?;
    let host = accounts_url
        .host_str()
        .ok_or_else(|| "accounts url missing host".to_string())?
        .to_string();

    let webview = shared_store_webview(&app)?;

    // Match Accounts cookie flags (`secure` + `sameSite: none`) so `/api/login/sites`
    // receives `_atid` on cross-site POSTs from the login-sites page.
    let cookie = Cookie::build(("_atid", token.as_str()))
        .domain(host.clone())
        .path("/")
        .secure(true)
        .http_only(false)
        .same_site(SameSite::None)
        .build();
    webview
        .set_cookie(cookie)
        .map_err(|e| format!("set_cookie failed: {e}"))?;

    let probe: tauri::Url = format!("https://{host}/")
        .parse()
        .map_err(|e| format!("probe url: {e}"))?;
    let jar = webview.cookies_for_url(probe).unwrap_or_default();
    let has_atid = jar.iter().any(|c| c.name() == "_atid" && !c.value().is_empty());
    log::info!("[sso] seed host={host} persisted={has_atid}");
    log_token_shape("seed", &token);
    if !has_atid {
        return Err("set_cookie did not persist _atid".into());
    }
    Ok(())
}

/// Read the Accounts `_atid` session cookie back out of the shared product
/// cookie jar. Returns None when no shared-store webview exists yet or the
/// cookie is missing/empty. Used to (a) avoid clobbering a valid cookie on
/// re-seed and (b) diagnose silent-SSO failures without printing the token.
#[tauri::command]
pub async fn read_accounts_session(
    app: AppHandle,
    accounts_base: String,
) -> Result<Option<String>, String> {
    let base = accounts_base.trim_end_matches('/');
    let accounts_url: tauri::Url = base
        .parse()
        .map_err(|e| format!("invalid accounts url: {e}"))?;
    let host = accounts_url
        .host_str()
        .ok_or_else(|| "accounts url missing host".to_string())?
        .to_string();

    let Some(webview) = find_shared_store_webview(&app) else {
        log::info!("[sso] read _atid: no shared-store webview yet");
        return Ok(None);
    };

    let probe: tauri::Url = format!("https://{host}/")
        .parse()
        .map_err(|e| format!("probe url: {e}"))?;
    let jar = webview.cookies_for_url(probe).unwrap_or_default();
    let atid = jar
        .iter()
        .find(|c| c.name() == "_atid" && !c.value().is_empty())
        .map(|c| c.value().to_string());
    log::info!("[sso] read _atid present={} host={host}", atid.is_some());
    if let Some(value) = &atid {
        log_token_shape("read", value);
    }
    Ok(atid)
}

/// Remove the Accounts `_atid` from the shared product cookie jar so signing out
/// truly disables silent SSO (not just closes the webviews).
#[tauri::command]
pub async fn clear_accounts_session(
    app: AppHandle,
    accounts_base: String,
) -> Result<(), String> {
    let base = accounts_base.trim_end_matches('/');
    let accounts_url: tauri::Url = base
        .parse()
        .map_err(|e| format!("invalid accounts url: {e}"))?;
    let host = accounts_url
        .host_str()
        .ok_or_else(|| "accounts url missing host".to_string())?
        .to_string();

    // Only touch an already-existing shared-store webview; if none exists there
    // is nothing to clear (logout_webviews may have closed them all).
    let Some(webview) = find_shared_store_webview(&app) else {
        return Ok(());
    };

    // ponytail: best-effort expire + blank. WKWebView may keep a tombstone until
    // its store flushes, but an empty `_atid` already defeats silent SSO. Upgrade
    // path: a dedicated WKHTTPCookieStore delete selector if a residue appears.
    let cookie = Cookie::build(("_atid", ""))
        .domain(host)
        .path("/")
        .secure(true)
        .http_only(false)
        .same_site(SameSite::None)
        .expires(cookie::time::OffsetDateTime::UNIX_EPOCH)
        .build();
    webview
        .set_cookie(cookie)
        .map_err(|e| format!("clear _atid failed: {e}"))?;
    Ok(())
}

/// Wipe the ENTIRE shared WKWebsiteDataStore — every cookie (Accounts
/// `ec_session` + each product's own session), local storage, and caches — not
/// just the `_atid` cookie that `clear_accounts_session` expires. Called on
/// logout so the next user starts from a truly empty jar and Accounts `/login`
/// cannot auto-redirect as the previous user (the root cause of "sign in as B,
/// get signed in as A").
#[tauri::command]
pub async fn clear_shared_web_data(app: AppHandle) -> Result<(), String> {
    // `clear_all_browsing_data` wipes the data store its webview is pinned to, so
    // any SHARED_DATA_STORE webview works. Reuse an existing one; otherwise spin
    // up a hidden throwaway pinned to the shared store just for the wipe.
    let created = find_shared_store_webview(&app).is_none();
    let webview = shared_store_webview(&app)?;

    let _ = webview.clear_all_browsing_data();
    log::info!("[sso] clear_shared_web_data requested");

    // wry's macOS `clear_all_browsing_data` is fire-and-forget (`removeDataOfTypes`
    // with an empty completion handler). Give the async removal a grace window so
    // the store is actually empty before logout closes the webviews and before the
    // next user's `/login` loads — otherwise the load races the wipe and still
    // sees the previous session.
    // ponytail: fixed 500ms grace for the async wipe. Upgrade path: thread the
    // WKWebsiteDataStore completion handler through wry to resolve exactly when the
    // removal finishes instead of guessing.
    const CLEAR_GRACE_MS: u64 = 500;
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(CLEAR_GRACE_MS));
    })
    .await;

    // Tear down the throwaway webview created solely for the wipe.
    if created {
        if let Some(wv) = app.get_webview(ATID_SEED_LABEL) {
            let _ = wv.close();
        }
    }

    Ok(())
}

/// Show the target product webview (creating it on first use) and hide the rest
/// in this shell window. `url` is only used on creation; re-selecting preserves
/// state. New webviews stay hidden until first load completes (load-gating).
#[tauri::command]
pub async fn select_service(
    app: AppHandle,
    webview: Webview,
    service_id: String,
    url: String,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    let label = svc_label(&window_label, &service_id);
    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("shell window not found: {window_label}"))?;

    // Switching product clears aux tabs (plan: keep it simple).
    close_all_aux_tabs_for_window(&app, &window_label);

    hide_window_product_children(&app, &window_label, Some(&label));

    app.state::<ServiceWebviews>()
        .with_window_mut(&window_label, |s| {
            s.active = Some(service_id.clone());
            s.active_tab_id = None;
        });

    if let Some(child) = app.get_webview(&label) {
        let left_inset = app
            .state::<ServiceWebviews>()
            .with_window_mut(&window_label, |s| s.left_inset);
        if let Ok((pos, size)) = content_rect(&window, left_inset) {
            let _ = child.set_position(pos);
            let _ = child.set_size(size);
        }
        let _ = child.show();
        let stuck = app.state::<ServiceWebviews>().with_window_mut(&window_label, |s| {
            s.stuck_on_auth.contains(&service_id)
        });
        if !stuck {
            let _ = app.emit_to(shell_target(&window_label), "service-loaded", &service_id);
        }
        return Ok(());
    }

    build_service_webview(&app, &window, &window_label, &label, &service_id, &url)
}

/// Navigate an existing product webview (quick links / bookmarks).
#[tauri::command]
pub async fn navigate_service(
    app: AppHandle,
    webview: Webview,
    service_id: String,
    url: String,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    let child = app
        .get_webview(&svc_label(&window_label, &service_id))
        .ok_or("service webview not found")?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    child.navigate(parsed).map_err(|e| e.to_string())
}

/// Active surface webview: focused aux tab, or the active product service.
fn active_service_webview(app: &AppHandle, window_label: &str) -> Result<tauri::Webview, String> {
    let (active_tab, active_service) = app.state::<ServiceWebviews>().with_window_mut(window_label, |s| {
        (s.active_tab_id.clone(), s.active.clone())
    });
    if let Some(tab_id) = active_tab {
        return app
            .get_webview(&tab_label(window_label, &tab_id))
            .ok_or_else(|| "tab webview not found".into());
    }
    let active = active_service.ok_or("no active service")?;
    app.get_webview(&svc_label(window_label, &active))
        .ok_or_else(|| "service webview not found".into())
}

/// Walk the active product webview's history back one step.
#[tauri::command]
pub async fn service_history_back(app: AppHandle, webview: Webview) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    active_service_webview(&app, &window_label)?
        .eval("window.history.back()")
        .map_err(|e| e.to_string())
}

/// Walk the active product webview's history forward one step.
#[tauri::command]
pub async fn service_history_forward(app: AppHandle, webview: Webview) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    active_service_webview(&app, &window_label)?
        .eval("window.history.forward()")
        .map_err(|e| e.to_string())
}

/// Reload the active product webview (user-triggered recovery).
#[tauri::command]
pub async fn reload_service(app: AppHandle, webview: Webview) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    active_service_webview(&app, &window_label)?
        .eval("window.location.reload()")
        .map_err(|e| e.to_string())
}

/// Open the OS-native DevTools inspector on the active product webview.
/// Requires the `devtools` Cargo feature (enabled unconditionally, not just
/// `--debug` builds) so the Settings "Dev mode" DevTools button works in a
/// signed release. Called only while `environmentMode === "dev"` — see
/// `DesktopSettings.tsx`.
#[tauri::command]
pub async fn open_active_service_devtools(app: AppHandle, webview: Webview) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    active_service_webview(&app, &window_label)?.open_devtools();
    Ok(())
}

/// Update the left chrome inset (logical px) for this shell and reposition its
/// product children immediately.
#[tauri::command]
pub async fn set_content_left_inset(
    app: AppHandle,
    webview: Webview,
    left_inset: f64,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    app.state::<ServiceWebviews>()
        .with_window_mut(&window_label, |s| s.left_inset = left_inset);
    reposition_window(&app, &window_label);
    Ok(())
}

/// Hide/show the active product/tab webview so shell overlays that overhang the
/// content area (e.g. the user menu) are not occluded by the native layer.
#[tauri::command]
pub async fn set_service_visible(
    app: AppHandle,
    webview: Webview,
    visible: bool,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    if let Ok(child) = active_service_webview(&app, &window_label) {
        let _ = if visible { child.show() } else { child.hide() };
    }
    Ok(())
}

/// Focus an aux tab (`Some(id)`) or the primary service surface (`None`).
#[tauri::command]
pub async fn focus_product_tab(
    app: AppHandle,
    webview: Webview,
    tab_id: Option<String>,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    focus_product_tab_inner(&app, &window_label, tab_id.as_deref())
}

/// Close an auxiliary product tab and return to the primary service surface.
#[tauri::command]
pub async fn close_product_tab(
    app: AppHandle,
    webview: Webview,
    tab_id: String,
) -> Result<(), String> {
    let window_label = caller_shell_label(&webview)?;
    close_product_tab_inner(&app, &window_label, &tab_id)
}

/// Product bridge: open allowlisted URLs as in-app tabs; others in the system browser.
#[tauri::command]
pub async fn desktop_open_or_tab(
    app: AppHandle,
    webview: Webview,
    url: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let (window_label, opener) = opener_service_from_label(&app, &label).ok_or_else(|| {
        format!("desktop_open_or_tab only from product/tab webviews, got {label}")
    })?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    handle_new_window_url(&app, &window_label, &opener, &parsed);
    Ok(())
}

/// Tear down all product webviews and clear per-window active state.
/// Used on logout and account switch (shared cookie jar). Sign-out UI sync
/// across shells is emitted from the frontend after the store is cleared —
/// this command alone also runs mid-switch and must not broadcast signed-out.
#[tauri::command]
pub async fn logout_webviews(app: AppHandle) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with(SVC_PREFIX)
            || label.starts_with(TAB_PREFIX)
            || label == ATID_SEED_LABEL
        {
            let _ = webview.close();
        }
    }
    {
        let state = app.state::<ServiceWebviews>();
        let mut map = state.by_window.lock().unwrap();
        for window_state in map.values_mut() {
            window_state.active = None;
            window_state.stuck_on_auth.clear();
            window_state.tabs.clear();
            window_state.active_tab_id = None;
        }
    }
    Ok(())
}
