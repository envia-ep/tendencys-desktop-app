//! Native multi-webview management (Tauri `unstable`).
//!
//! Every call into the experimental multiwebview API is isolated here so a
//! future `unstable` API change is a single-file fix. The shell (main webview)
//! renders chrome; each product and the Accounts login render as child webviews
//! overlaid on the content area, sharing the macOS WKWebView cookie store.
//!
//! Child webview labels:
//! - `svc-<service_id>` — one per product, shown/hidden on menu switch.
//! - `auth` — transient Accounts login (left-inset so LoginPage recovery rail
//!   stays visible), closed once the token is captured.
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

use std::collections::HashSet;
use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use cookie::SameSite;
use tauri::{
    webview::{Cookie, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime, Webview,
    WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;

use crate::desktop_files::unique_download_path;

#[derive(Clone, Serialize)]
struct ServiceNavigatedPayload {
    service_id: String,
    url: String,
    replace: bool,
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

/// Bring the shell window to the front (deep link, macOS Dock reopen,
/// Windows/Linux tray Show, second-instance). Repositions product webviews
/// after the window was hidden. Uses `get_window` — `get_webview_window("main")`
/// is often None in this multiwebview setup (same as CloseRequested hide).
pub fn focus_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    reposition_all(app);
}

/// Handle OS deep links: Accounts auth handoff or open a product/section.
///
/// - `tendencys://authentication?authorization=…` → `shell-auth-token`
/// - `tendencys://open/<target>` (product id or shell section) → `shell-open`
pub fn emit_deep_link(app: &AppHandle, urls: &[String]) {
    for raw in urls {
        if let Some(token) = extract_deep_link_authorization(raw) {
            focus_main_window(app);
            log::info!("[sso] deep-link shell-auth-token emitted");
            let _ = app.emit_to(
                main_target(),
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
            log::info!("[shell] deep-link open target={target_id}");
            let _ = app.emit_to(main_target(), "shell-open", target_id);
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
})();
"#;

fn emit_service_navigated<R: Runtime>(
    app: &AppHandle<R>,
    service_id: &str,
    url: &str,
    replace: bool,
) {
    app.state::<ServiceWebviews>()
        .stuck_on_auth
        .lock()
        .unwrap()
        .remove(service_id);
    let _ = app.emit_to(
        main_target(),
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
    let service_id = label
        .strip_prefix(SVC_PREFIX)
        .ok_or_else(|| format!("desktop_report_nav only from product webviews, got {label}"))?
        .to_string();

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

    emit_service_navigated(&app, &service_id, &url, replace);
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
    service_id: &str,
    url: &tauri::Url,
) -> bool {
    if !is_accounts_step_up(url) {
        return false;
    }
    app.state::<ServiceWebviews>()
        .stuck_on_auth
        .lock()
        .unwrap()
        .insert(service_id.to_string());
    let _ = app.emit_to(main_target(), "verification-required", service_id);
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
const MAIN_WINDOW: &str = "main";

/// Shared WKWebView data store so `auth` + every `svc-*` webview see the same
/// cookie jar (notably the `_atid` session cookie that drives `/login-sites`
/// SSO). Fixed bytes = "TendencysDesktop" so the store is stable across launches.
const SHARED_DATA_STORE: [u8; 16] = *b"TendencysDesktop";

/// Only the main (shell) webview should receive shell events — never the remote
/// product/Accounts webviews.
fn main_target() -> EventTarget {
    EventTarget::labeled(MAIN_WINDOW)
}

/// Tracks which service webview is currently front-most (for resize/visibility
/// commands and the load-gate) and the current left chrome inset (for the
/// collapsible service menu's width).
pub struct ServiceWebviews {
    pub active: Mutex<Option<String>>,
    pub left_inset: Mutex<f64>,
    /// service_ids currently parked on an Accounts fallback page: the
    /// auth-required login form (`/login` or the `/login-sites` relay) or a
    /// pending verification step-up (`/verify`, `/accept-terms`,
    /// `/phone-verification`, `/verify-device`). Re-selecting an
    /// already-mounted webview in this state must not report "loaded" — the
    /// webview is still showing an Accounts page, not the product.
    pub stuck_on_auth: Mutex<HashSet<String>>,
}

impl Default for ServiceWebviews {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
            left_inset: Mutex::new(DEFAULT_LEFT_INSET),
            stuck_on_auth: Mutex::new(HashSet::new()),
        }
    }
}

fn svc_label(service_id: &str) -> String {
    format!("{SVC_PREFIX}{service_id}")
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

/// Reposition every child webview to track the window on resize / DPI change.
pub fn reposition_all<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        return;
    };
    let left_inset = *app.state::<ServiceWebviews>().left_inset.lock().unwrap();
    if let Ok((pos, size)) = content_rect(&window, left_inset) {
        for (label, webview) in app.webviews() {
            if label.starts_with(SVC_PREFIX) {
                let _ = webview.set_position(pos);
                let _ = webview.set_size(size);
            }
        }
    }
}

/// Create a hidden product webview glued to the content area. The webview stays
/// hidden until `on_page_load(Finished)` and only reveals itself when it is the
/// active service, so a mid-load webview never flashes a blank native rect.
/// A fallback to the interactive Accounts `/login` form (expired shared session)
/// emits `auth-required` so the caller can reveal a stuck hidden webview.
fn build_service_webview(
    app: &AppHandle,
    window: &tauri::Window,
    label: &str,
    service_id: &str,
    url: &str,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let left_inset = *app.state::<ServiceWebviews>().left_inset.lock().unwrap();
    let (pos, size) = content_rect(window, left_inset).map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let id_for_nav = service_id.to_string();
    let app_for_load = app.clone();
    let id_for_load = service_id.to_string();

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
                    true
                }
                _ => true,
            }
        })
        .on_new_window(move |url, _features| {
            if url.scheme() == "http" || url.scheme() == "https" {
                if let Err(err) = app_for_new_window
                    .opener()
                    .open_url(url.as_str(), None::<&str>)
                {
                    log::warn!("[desktop-files] open_url failed for {url}: {err}");
                }
            }
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            // login-sites falls back to the interactive form when the shared
            // `_atid` is missing/expired. Surface it so the webview can be
            // revealed for one re-auth instead of silently stuck on a form.
            // Product `/login` (except Shipping's mid-handoff token relay) is the
            // same class of failure.
            if emit_auth_required_if_login(&app_for_nav, &id_for_nav, url) {
                return true;
            }

            // Same class of "not actually loaded" fallback as the check above,
            // but for a pending 2FA/terms/phone step-up rather than a dead
            // session — see `emit_verification_required_if_stepup`.
            if emit_verification_required_if_stepup(&app_for_nav, &id_for_nav, url) {
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
                emit_service_navigated(&app_for_nav, &id_for_nav, &url.to_string(), false);
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
            let auth_required = emit_auth_required_if_login(&app_for_load, &id_for_load, loaded_url);
            let verification_required =
                emit_verification_required_if_stepup(&app_for_load, &id_for_load, loaded_url);
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
                    &id_for_load,
                    &loaded_url.to_string(),
                    false,
                );
            }
            let active = app_for_load
                .state::<ServiceWebviews>()
                .active
                .lock()
                .unwrap()
                .clone();
            if active.as_deref() == Some(id_for_load.as_str()) {
                let _ = webview.show();
            }
            // Do not report "loaded" for the auth-required fallback page, a
            // pending verification step-up page, the `/login-sites` relay
            // spinner, or product `/authentication` mid-handoff — otherwise
            // any of these clears the reseed-retry guard (or, for step-up,
            // gets mistaken for the product itself) as if the product had
            // actually loaded.
            if !auth_required && !verification_required && !is_sso_relay && !is_auth_callback {
                let _ = app_for_load.emit_to(main_target(), "service-loaded", &id_for_load);
            }
        });

    let webview = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    // Hidden until on_page_load(Finished) reveals it (only if active).
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
        .find(|(label, _)| label.starts_with(SVC_PREFIX))
        .map(|(_, wv)| wv)
}

/// Find or create a hidden webview on SHARED_DATA_STORE for cookie jar ops.
fn shared_store_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    if let Some(existing) = find_shared_store_webview(app) {
        return Ok(existing);
    }
    let window = app.get_window(MAIN_WINDOW).ok_or("main window not found")?;
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
fn emit_auth_required_if_login(app: &AppHandle, service_id: &str, url: &tauri::Url) -> bool {
    let is_accounts_login = is_accounts_host(url) && url.path() == "/login";
    let is_product_login = !is_accounts_host(url)
        && url.path() == "/login"
        && !is_temporal_token_relay(url);
    if is_accounts_login || is_product_login {
        app.state::<ServiceWebviews>()
            .stuck_on_auth
            .lock()
            .unwrap()
            .insert(service_id.to_string());
        let _ = app.emit_to(main_target(), "auth-required", service_id);
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

/// Show the target product webview (creating it on first use) and hide the rest.
/// `url` is only used on creation; re-selecting an existing service preserves its
/// state. New webviews stay hidden until first load completes (load-gating), so
/// switching shows the shell's loading overlay instead of a blank native rect.
#[tauri::command]
pub async fn select_service(
    app: AppHandle,
    service_id: String,
    url: String,
) -> Result<(), String> {
    let label = svc_label(&service_id);
    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or("main window not found")?;

    for (other, webview) in app.webviews() {
        if other.starts_with(SVC_PREFIX) && other != label {
            let _ = webview.hide();
        }
    }

    *app.state::<ServiceWebviews>().active.lock().unwrap() = Some(service_id.clone());

    if let Some(webview) = app.get_webview(&label) {
        // Re-apply left inset in case the menu width changed while this webview
        // was hidden in the background.
        let left_inset = *app.state::<ServiceWebviews>().left_inset.lock().unwrap();
        if let Ok((pos, size)) = content_rect(&window, left_inset) {
            let _ = webview.set_position(pos);
            let _ = webview.set_size(size);
        }
        let _ = webview.show();
        // Skip "loaded" when this webview is currently parked on the
        // auth-required fallback — re-selecting it must not clear the
        // reseed-retry guard as if the product had actually loaded.
        let stuck = app
            .state::<ServiceWebviews>()
            .stuck_on_auth
            .lock()
            .unwrap()
            .contains(&service_id);
        if !stuck {
            let _ = app.emit_to(main_target(), "service-loaded", &service_id);
        }
        return Ok(());
    }

    build_service_webview(&app, &window, &label, &service_id, &url)
}

/// Navigate an existing product webview (quick links / bookmarks).
#[tauri::command]
pub async fn navigate_service(
    app: AppHandle,
    service_id: String,
    url: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&svc_label(&service_id))
        .ok_or("service webview not found")?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

/// Walk the active product webview's history back one step.
#[tauri::command]
pub async fn service_history_back(app: AppHandle) -> Result<(), String> {
    let active = app
        .state::<ServiceWebviews>()
        .active
        .lock()
        .unwrap()
        .clone()
        .ok_or("no active service")?;
    let webview = app
        .get_webview(&svc_label(&active))
        .ok_or("service webview not found")?;
    webview
        .eval("window.history.back()")
        .map_err(|e| e.to_string())
}

/// Walk the active product webview's history forward one step.
#[tauri::command]
pub async fn service_history_forward(app: AppHandle) -> Result<(), String> {
    let active = app
        .state::<ServiceWebviews>()
        .active
        .lock()
        .unwrap()
        .clone()
        .ok_or("no active service")?;
    let webview = app
        .get_webview(&svc_label(&active))
        .ok_or("service webview not found")?;
    webview
        .eval("window.history.forward()")
        .map_err(|e| e.to_string())
}

/// Reload the active product webview (user-triggered recovery).
#[tauri::command]
pub async fn reload_service(app: AppHandle) -> Result<(), String> {
    let active = app
        .state::<ServiceWebviews>()
        .active
        .lock()
        .unwrap()
        .clone()
        .ok_or("no active service")?;
    let webview = app
        .get_webview(&svc_label(&active))
        .ok_or("service webview not found")?;
    webview
        .eval("window.location.reload()")
        .map_err(|e| e.to_string())
}

/// Update the left chrome inset (logical px) to match the collapsible service
/// menu's current width and reposition every child webview immediately.
#[tauri::command]
pub async fn set_content_left_inset(app: AppHandle, left_inset: f64) -> Result<(), String> {
    *app.state::<ServiceWebviews>().left_inset.lock().unwrap() = left_inset;
    reposition_all(&app);
    Ok(())
}

/// Hide/show the active product webview so shell overlays that overhang the
/// content area (e.g. the user menu) are not occluded by the native layer.
#[tauri::command]
pub async fn set_service_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let active = app
        .state::<ServiceWebviews>()
        .active
        .lock()
        .unwrap()
        .clone();
    if let Some(id) = active {
        if let Some(webview) = app.get_webview(&svc_label(&id)) {
            let _ = if visible { webview.show() } else { webview.hide() };
        }
    }
    Ok(())
}

/// Tear down all product webviews on logout and clear active state.
#[tauri::command]
pub async fn logout_webviews(app: AppHandle) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with(SVC_PREFIX) || label == ATID_SEED_LABEL {
            let _ = webview.close();
        }
    }
    *app.state::<ServiceWebviews>().active.lock().unwrap() = None;
    Ok(())
}
