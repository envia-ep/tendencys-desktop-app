mod device_key;
mod webview_manager;

use std::sync::Arc;

use device_key::{
    delete_device_key, generate_device_keypair, get_device_key_meta, has_device_key,
    login_with_device_key, register_device_key, set_device_key_method_id,
};
use sentry::protocol::{Breadcrumb, Event, Value};
use webview_manager::{
    clear_accounts_session, clear_shared_web_data, close_shell_login, logout_webviews,
    navigate_service, open_shell_login, prewarm_service, read_accounts_session, reload_service,
    reposition_all, seed_accounts_session, select_service, service_history_back,
    service_history_forward, set_content_left_inset, set_service_visible, ServiceWebviews,
};

/// Substrings that mark a key or query param as carrying an auth secret we must
/// never ship to Sentry. Mirrors the "never print the token" discipline in
/// `sso-log.ts` / `device_key.rs`.
fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["authorization", "_atid", "token", "redirect_url", "cookie"]
        .iter()
        .any(|needle| key.contains(needle))
}

/// Redact sensitive query-string values from a URL, keeping the path for triage.
fn scrub_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let scrubbed = query
        .split('&')
        .map(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            if is_sensitive_key(key) {
                format!("{key}=[Filtered]")
            } else {
                pair.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{scrubbed}")
}

/// Recursively redact sensitive keys and secret-bearing URLs from a JSON value.
fn scrub_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if is_sensitive_key(key) {
                    *val = Value::String("[Filtered]".into());
                } else {
                    scrub_value(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_value),
        Value::String(text) => {
            if text.contains("://") && text.contains('?') {
                *text = scrub_url(text);
            }
        }
        _ => {}
    }
}

/// `before_breadcrumb` hook: scrub secrets out of every breadcrumb payload.
fn scrub_breadcrumb(mut breadcrumb: Breadcrumb) -> Option<Breadcrumb> {
    for value in breadcrumb.data.values_mut() {
        scrub_value(value);
    }
    Some(breadcrumb)
}

/// `before_send` hook: scrub request URL/headers/cookies/query, breadcrumbs, and
/// extra data before any native event leaves the process.
fn scrub_event(mut event: Event<'static>) -> Option<Event<'static>> {
    if let Some(request) = event.request.as_mut() {
        if let Some(url) = request.url.take() {
            request.url = scrub_url(url.as_str()).parse().ok();
        }
        for (key, value) in request.headers.iter_mut() {
            if is_sensitive_key(key) {
                *value = "[Filtered]".to_string();
            }
        }
        request.cookies = None;
        if let Some(query) = request.query_string.take() {
            request.query_string = Some(
                scrub_url(&format!("?{query}"))
                    .trim_start_matches('?')
                    .to_string(),
            );
        }
        // `data` is the raw request body string; redact wholesale if it may
        // carry a secret rather than risk leaking a token embedded in JSON.
        if request.data.as_deref().is_some_and(is_sensitive_key) {
            request.data = Some("[Filtered]".to_string());
        }
    }
    for breadcrumb in event.breadcrumbs.values.iter_mut() {
        for value in breadcrumb.data.values_mut() {
            scrub_value(value);
        }
    }
    for value in event.extra.values_mut() {
        scrub_value(value);
    }
    Some(event)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Sentry must init first: everything above `minidump::init` runs in BOTH the
    // app process and the separate crash-reporter subprocess. Disabled
    // automatically when SENTRY_DSN was not baked in at compile time (local
    // dev), so nothing breaks off-CI.
    // ponytail: iOS is not a target for this desktop shell, so the minidump
    // guard is registered unconditionally (upstream gates it behind
    // cfg(not(target_os = "ios"))).
    let dsn = option_env!("SENTRY_DSN").unwrap_or("");
    let _sentry_guard = (!dsn.is_empty()).then(|| {
        let client = sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                environment: Some(
                    if cfg!(debug_assertions) {
                        "development"
                    } else {
                        "production"
                    }
                    .into(),
                ),
                auto_session_tracking: true,
                send_default_pii: false,
                before_send: Some(Arc::new(scrub_event)),
                before_breadcrumb: Some(Arc::new(scrub_breadcrumb)),
                ..Default::default()
            },
        ));
        let minidump_guard = tauri_plugin_sentry::minidump::init(&client);
        (client, minidump_guard)
    });

    let mut builder = tauri::Builder::default();

    // Route webview + native events through the Rust client. `no_injection`
    // keeps @sentry/browser out of the third-party product webviews
    // (ship.envia.com, etc.) — the shell inits its own SDK in main.tsx instead.
    if let Some((client, _)) = _sentry_guard.as_ref() {
        builder = builder.plugin(tauri_plugin_sentry::init_with_no_injection(client));
    }

    // Must be registered before deep-link so a second launch forwards the
    // tendencys:// auth callback into the already-running instance.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ServiceWebviews::default())
        .invoke_handler(tauri::generate_handler![
            validate_accounts_token,
            has_device_key,
            get_device_key_meta,
            generate_device_keypair,
            set_device_key_method_id,
            delete_device_key,
            login_with_device_key,
            register_device_key,
            select_service,
            prewarm_service,
            navigate_service,
            service_history_back,
            service_history_forward,
            reload_service,
            set_service_visible,
            set_content_left_inset,
            open_shell_login,
            close_shell_login,
            logout_webviews,
            seed_accounts_session,
            clear_accounts_session,
            clear_shared_web_data,
            read_accounts_session
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            // Always log to a file (LogDir) so `[sso]` diagnostics are recoverable
            // from an affected user's release build; add stdout only in debug.
            // macOS: ~/Library/Logs/com.tendencys.desktop/tendencys.log
            {
                use tauri_plugin_log::{Target, TargetKind};
                let mut targets = vec![Target::new(TargetKind::LogDir {
                    file_name: Some("tendencys".into()),
                })];
                if cfg!(debug_assertions) {
                    targets.push(Target::new(TargetKind::Stdout));
                }
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .targets(targets)
                        .build(),
                )?;
            }

            // Keep child webviews glued to the content area on resize / DPI change.
            use tauri::Manager;
            if let Some(window) = app.get_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        reposition_all(&handle);
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Validate an Accounts handoff JWT server-side so we can set Referer=aud
/// (forbidden in browser fetch) and avoid CORS/CORP from the webview.
#[tauri::command]
async fn validate_accounts_token(
    accounts_base_url: String,
    site_id: String,
    token: String,
    referer: String,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/api/accounts/authorization",
        accounts_base_url.trim_end_matches('/')
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", &token)
        .header("X-Client-ID", &site_id)
        .header("Referer", &referer)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|err| format!("Accounts request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Accounts response: {err}"))?;

    if !status.is_success() {
        return Err(format!("Accounts authorization failed ({status}): {body}"));
    }

    serde_json::from_str(&body)
        .map_err(|err| format!("Invalid Accounts JSON: {err}; body={body}"))
}
