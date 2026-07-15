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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// True once the shared WKWebsiteDataStore has been wiped for the interactive
/// `/login` in this app run. Any stale/foreign Accounts session (e.g. an
/// `ec_session` from a prior install) only needs clearing on the FIRST interactive
/// login; repeated retries within the same run reuse the now-clean jar instead of
/// re-clearing and re-loading `/login`. Reset on logout/account switch so the next
/// user starts clean again.
static SHARED_JAR_CLEARED: AtomicBool = AtomicBool::new(false);

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use cookie::SameSite;
use tauri::{
    webview::{Cookie, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
};

#[derive(Clone, Serialize)]
struct ServiceNavigatedPayload {
    service_id: String,
    url: String,
    replace: bool,
}

/// Emitted when the in-app Accounts login captures the handoff JWT. `atid` is the
/// real Accounts session cookie (`createSessionToken`: id + aud) the `/login` page
/// just set in the shared jar — the token the shell must reuse for silent SSO and
/// device-key registration (the `/api/accounts/authorization` token lacks `id`).
#[derive(Clone, Serialize)]
struct ShellAuthPayload {
    token: String,
    atid: Option<String>,
}

/// SPA hook: patches history.* and pings the shell via a cancelled custom navigation.
const SPA_NAV_HOOK: &str = r#"
(function () {
  if (window.__tendencysShellNav) return;
  window.__tendencysShellNav = true;
  var last = location.href;
  function ping(replace) {
    try {
      var href = location.href;
      if (!replace && href === last) return;
      last = href;
      var kind = replace ? 'r' : 'p';
      location.assign('tendencys-nav://' + kind + '?' + encodeURIComponent(href));
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

fn emit_service_navigated(app: &AppHandle, service_id: &str, url: &str, replace: bool) {
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

fn is_accounts_host(url: &tauri::Url) -> bool {
    url.host_str()
        .map(|h| h.to_ascii_lowercase().contains("accounts"))
        .unwrap_or(false)
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

/// Read the non-empty `_atid` cookie for `host` from a specific webview's jar.
fn read_atid_from_webview(app: &AppHandle, label: &str, host: &str) -> Option<String> {
    let webview = app.get_webview(label)?;
    let probe: tauri::Url = format!("https://{host}/").parse().ok()?;
    let jar = webview.cookies_for_url(probe).unwrap_or_default();
    jar.iter()
        .find(|c| c.name() == "_atid" && !c.value().is_empty())
        .map(|c| c.value().to_string())
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

/// Left inset for the Accounts login webview so LoginPage's recovery rail stays
/// visible. Must match `LOGIN_RAIL_WIDTH` in `src/config/layout.ts`.
const AUTH_LEFT_INSET: f64 = 56.0;

const AUTH_LABEL: &str = "auth";
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
}

impl Default for ServiceWebviews {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
            left_inset: Mutex::new(DEFAULT_LEFT_INSET),
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
    // Auth leaves a left strip for LoginPage recovery controls.
    if let Ok((pos, size)) = content_rect(&window, AUTH_LEFT_INSET) {
        if let Some(webview) = app.get_webview(AUTH_LABEL) {
            let _ = webview.set_position(pos);
            let _ = webview.set_size(size);
        }
    }
}

/// Create a hidden product webview glued to the content area. The webview stays
/// hidden until `on_page_load(Finished)` and only reveals itself when it is the
/// active service, so background pre-warming never flashes a blank native rect.
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

    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_store_identifier(SHARED_DATA_STORE)
        .initialization_script(SPA_NAV_HOOK)
        .on_navigation(move |url| {
            // SPA hook: cancelled custom scheme carries push/replace + href.
            if url.scheme() == "tendencys-nav" {
                let replace = url.host_str() == Some("r");
                if let Some(raw) = url.query() {
                    if let Ok(href) = urlencoding::decode(raw) {
                        emit_service_navigated(&app_for_nav, &id_for_nav, &href, replace);
                    }
                }
                return false;
            }

            // login-sites falls back to the interactive form when the shared
            // `_atid` is missing/expired. Surface it so a hidden pre-warm webview
            // is revealed for one re-auth instead of silently stuck on a form.
            // Product `/login` (except Shipping's mid-handoff token relay) is the
            // same class of failure.
            if emit_auth_required_if_login(&app_for_nav, &id_for_nav, url) {
                return true;
            }

            // Document navigations on product hosts (skip Accounts SSO hops).
            if !is_accounts_host(url)
                && url.path() != "/login-sites"
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
            let _ = emit_auth_required_if_login(&app_for_load, &id_for_load, loaded_url);
            if !is_accounts_host(loaded_url)
                && loaded_url.path() != "/login-sites"
                && loaded_url.path() != "/login"
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
            let _ = app_for_load.emit_to(main_target(), "service-loaded", &id_for_load);
        });

    let webview = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    // Hidden until on_page_load(Finished) reveals it (only if active).
    let _ = webview.hide();
    Ok(())
}

/// Find any existing webview pinned to SHARED_DATA_STORE (seed / svc-* / auth).
fn find_shared_store_webview(app: &AppHandle) -> Option<tauri::Webview> {
    if let Some(existing) = app.get_webview(ATID_SEED_LABEL) {
        return Some(existing);
    }
    app.webviews()
        .into_iter()
        .find(|(label, _)| label.starts_with(SVC_PREFIX) || label.as_str() == AUTH_LABEL)
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
        // was hidden (pre-warm / background).
        let left_inset = *app.state::<ServiceWebviews>().left_inset.lock().unwrap();
        if let Ok((pos, size)) = content_rect(&window, left_inset) {
            let _ = webview.set_position(pos);
            let _ = webview.set_size(size);
        }
        let _ = webview.show();
        let _ = app.emit_to(main_target(), "service-loaded", &service_id);
        return Ok(());
    }

    build_service_webview(&app, &window, &label, &service_id, &url)
}

/// Background-create a product webview (hidden) and run its SSO handoff so a later
/// rail click is instant. Unlike `select_service`, this never changes the active
/// service or shows the webview. No-op if the webview already exists.
#[tauri::command]
pub async fn prewarm_service(
    app: AppHandle,
    service_id: String,
    url: String,
) -> Result<(), String> {
    let label = svc_label(&service_id);
    if app.get_webview(&label).is_some() {
        return Ok(());
    }
    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or("main window not found")?;

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

/// Open the Accounts login (or signup) in a child webview (left-inset so
/// LoginPage recovery rail stays visible) and capture the
/// `tendencys://authentication?authorization=<jwt>` redirect in-app, without
/// ever touching the system browser.
#[tauri::command]
pub async fn open_shell_login(
    app: AppHandle,
    accounts_base: String,
    site_id: String,
    redirect_b64: String,
    auth_path: String,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview(AUTH_LABEL) {
        let _ = existing.close();
    }

    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or("main window not found")?;

    // Base64 uses +, /, = which are unsafe unescaped in a query value.
    let redirect = redirect_b64
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D");
    // Full-page OAuth modes: GSI + Apple popups fail silently inside WKWebView.
    let login_url = format!(
        "{}/{}?site_id={}&redirect_url={}&google_login_mode=redirection&apple_login_mode=redirection",
        accounts_base.trim_end_matches('/'),
        auth_path,
        site_id,
        redirect
    );
    eprintln!("[open_shell_login] {login_url}");

    // Interactive "Sign in" (auth_path == "login") only ever runs after silent
    // device-key SSO already failed, so any Accounts web session lingering in the
    // shared jar (e.g. a stale `ec_session` from a prior install) is not ours to
    // reuse — and if present it makes `/login` auto-redirect to the deep link and
    // close this webview before the form paints, leaving a dead white pane. Wipe
    // the shared store first so `/login` renders the real form. Signup never
    // auto-redirects, so it loads its URL directly.
    // Clear only on the FIRST interactive `/login` of this run (see
    // SHARED_JAR_CLEARED). `swap` flips the flag and tells us whether a prior open
    // already wiped the jar, so repeated retries skip the clear+re-navigate churn
    // that otherwise reloads the whole Accounts page (env.js, recaptcha,
    // /api/login/sites) each time. Short-circuit keeps signup from touching it.
    let needs_clear = auth_path == "login" && !SHARED_JAR_CLEARED.swap(true, Ordering::SeqCst);
    let initial_url = if needs_clear { "about:blank" } else { &login_url };
    let parsed: tauri::Url = initial_url
        .parse()
        .map_err(|e| format!("invalid url: {e}"))?;
    let (pos, size) = content_rect(&window, AUTH_LEFT_INSET).map_err(|e| e.to_string())?;

    // Accounts host, captured for reading the `_atid` the /login page sets in the
    // shared jar the moment we intercept the handoff callback (webview still alive).
    let accounts_host = tauri::Url::parse(accounts_base.trim_end_matches('/'))
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()));

    let app_for_nav = app.clone();
    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(AUTH_LABEL, WebviewUrl::External(parsed))
        .data_store_identifier(SHARED_DATA_STORE)
        .on_navigation(move |url| {
            let scheme = url.scheme();
            let is_callback = scheme == "tendencys" && url.host_str() == Some("authentication");
            if !is_callback {
                // Log every real navigation (skip internal schemes) so devs can trace
                // what the accounts page does inside the auth webview.
                if scheme == "https" || scheme == "http" {
                    log::info!("[auth-nav] -> {}", url.as_str());
                }
                return true;
            }
            if let Some((_, token)) = url.query_pairs().find(|(k, _)| k == "authorization") {
                let atid = accounts_host
                    .as_deref()
                    .and_then(|host| read_atid_from_webview(&app_for_nav, AUTH_LABEL, host));
                log::info!("[sso] shell-auth-token captured atid_present={}", atid.is_some());
                let _ = app_for_nav.emit_to(
                    main_target(),
                    "shell-auth-token",
                    ShellAuthPayload {
                        token: token.into_owned(),
                        atid,
                    },
                );
                // Keep the auth webview alive briefly so the shared WKWebsiteDataStore
                // finishes committing the Accounts `_atid` session cookie before we
                // tear it down. Product `/login-sites` handoffs race this close.
                let app_close = app_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let app_on_main = app_close.clone();
                    let _ = app_close.run_on_main_thread(move || {
                        if let Some(webview) = app_on_main.get_webview(AUTH_LABEL) {
                            let _ = webview.close();
                        }
                    });
                });
            }
            // Cancel the deep-link navigation; the shell handles the token.
            false
        })
        .on_page_load(move |webview, payload| {
            let event_name = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            log::info!("[auth-load] {} url={}", event_name, payload.url().as_str());
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            // Ignore the `about:blank` bootstrap used while we wipe the shared
            // store — revealing/emitting on it would flash a blank pane and tell
            // LoginPage the form is ready before `/login` has even loaded.
            if payload.url().scheme() == "about" {
                return;
            }
            // Reveal only once the Accounts form has actually painted, so the
            // native rect never flashes its blank/black pre-load surface —
            // mirrors the load-gating pattern used for product webviews.
            let _ = webview.show();
            // Real "the Accounts form is now visible and interactive" signal —
            // LoginPage uses this to stop its connecting timeout instead of
            // guessing a fixed duration that would fire while the user types.
            let _ = app_for_load.emit_to(main_target(), "shell-login-loaded", ());
        });

    let webview = window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    // Hidden until on_page_load(Finished) reveals it — avoids a dark flash of
    // the empty native webview while the Accounts page is still loading.
    let _ = webview.hide();

    // When clearing, wipe the shared WKWebsiteDataStore (all `accounts.*`
    // cookies + storage, not just `_atid`) then navigate to `/login`. wry's
    // macOS `clear_all_browsing_data` is fire-and-forget
    // (`removeDataOfTypes:...` with an empty completion handler), so we give the
    // async removal a short grace before loading `/login` — otherwise the load
    // would race the wipe and still see the stale session.
    // ponytail: fixed 500ms grace for the async data wipe. Upgrade path: thread
    // the WKWebsiteDataStore completion handler through wry to navigate exactly
    // when the removal finishes instead of guessing.
    const CLEAR_GRACE_MS: u64 = 500;
    if needs_clear {
        let _ = webview.clear_all_browsing_data();
        let app_nav = app.clone();
        let login_url_nav = login_url.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(CLEAR_GRACE_MS));
            let app_on_main = app_nav.clone();
            let _ = app_nav.run_on_main_thread(move || {
                if let (Some(webview), Ok(url)) =
                    (app_on_main.get_webview(AUTH_LABEL), login_url_nav.parse())
                {
                    let _ = webview.navigate(url);
                }
            });
        });
    }

    // Fallback reveal: the Accounts /login route runs a WebAuthn
    // conditional-mediation / session probe on load that keeps WKWebView from
    // ever firing PageLoadEvent::Finished (/signup does not, which is why it
    // shows). Without this, the webview stays hidden forever — a blank white
    // pane the user cannot dismiss until the 20s connect timeout closes it.
    // Reveal and emit the "loaded" signal after a grace period if on_page_load
    // hasn't already; the page has reliably painted its form by then. When we
    // clear first, the /login load only starts after CLEAR_GRACE_MS, so push the
    // reveal out by that much.
    // ponytail: fixed 1500ms load grace, not event-driven — if a slow link ever
    // flashes the pre-paint surface, upgrade to a WKWebView didCommit hook.
    let reveal_delay = 1500 + if needs_clear { CLEAR_GRACE_MS } else { 0 };
    let app_reveal = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(reveal_delay));
        let app_on_main = app_reveal.clone();
        let _ = app_reveal.run_on_main_thread(move || {
            if let Some(webview) = app_on_main.get_webview(AUTH_LABEL) {
                let _ = webview.show();
                let _ = app_on_main.emit_to(main_target(), "shell-login-loaded", ());
            }
        });
    });

    Ok(())
}

/// Close the Accounts login webview without tearing down product webviews.
#[tauri::command]
pub async fn close_shell_login(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(AUTH_LABEL) {
        let _ = webview.close();
    }
    Ok(())
}

/// Tear down all product and auth webviews on logout and clear active state.
#[tauri::command]
pub async fn logout_webviews(app: AppHandle) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with(SVC_PREFIX)
            || label == AUTH_LABEL
            || label == ATID_SEED_LABEL
        {
            let _ = webview.close();
        }
    }
    *app.state::<ServiceWebviews>().active.lock().unwrap() = None;
    // Logout (and account switch) wipes the shared jar via the TS layer, so the
    // next interactive login must clear again to drop any leftover foreign session.
    SHARED_JAR_CLEARED.store(false, Ordering::SeqCst);
    Ok(())
}
