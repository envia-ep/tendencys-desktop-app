mod desktop_files;
mod device_key;
mod webview_manager;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use desktop_files::{desktop_deliver_file, list_printers, print_test_page, save_bytes};
use device_key::{
    delete_device_key, generate_device_keypair, get_device_key_meta, has_device_key,
    login_with_device_key, register_device_key, set_device_key_method_id,
};
use sentry::protocol::{Breadcrumb, Event, Value};
use webview_manager::{
    clear_accounts_session, clear_shared_web_data, desktop_report_nav, emit_deep_link,
    focus_main_window, logout_webviews, navigate_service, read_accounts_session, reload_service,
    reposition_all, seed_accounts_session, select_service, service_history_back,
    service_history_forward, set_content_left_inset, set_service_visible, ServiceWebviews,
};

/// When true, window CloseRequested may destroy the window. Red traffic-light / X
/// leaves this false and only hides. Real Quit (menu / Cmd+Q / tray) sets it and
/// calls `app.exit` — ExitRequested alone never fires if we always prevent_close.
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

fn request_quit(app: &tauri::AppHandle) {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second launch / deep-link handoff into a running (possibly hidden) app.
            focus_main_window(app);
            // Fallback: some platforms deliver the tendencys:// URL as a second-
            // instance launch arg rather than (or in addition to) the deep-link
            // plugin's on_open_url. emit_deep_link no-ops on non-matching
            // argv entries, so this is safe to call unconditionally.
            emit_deep_link(app, &argv);
        }));
    }

    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            navigate_service,
            service_history_back,
            service_history_forward,
            reload_service,
            set_service_visible,
            set_content_left_inset,
            logout_webviews,
            seed_accounts_session,
            clear_accounts_session,
            clear_shared_web_data,
            read_accounts_session,
            list_printers,
            save_bytes,
            print_test_page,
            desktop_deliver_file,
            desktop_report_nav
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

            // System-browser login returns via tendencys:// — handle in Rust so
            // the JWT reaches the shell even when JS onOpenUrl races mount.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().into_iter().map(|u| u.to_string()).collect();
                    emit_deep_link(&handle, &urls);
                });
                if let Ok(Some(start_urls)) = app.deep_link().get_current() {
                    let urls: Vec<String> =
                        start_urls.into_iter().map(|u| u.to_string()).collect();
                    emit_deep_link(app.handle(), &urls);
                }
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
            // Window X hides (Slack-style). Real quit goes through `request_quit`.
            // Hide via `get_window` — at CloseRequested, `get_webview_window("main")`
            // is None in this multiwebview setup, so hide would no-op while
            // prevent_close still ran and trapped the window open.
            use tauri::Manager;
            if let Some(window) = app.get_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        if !ALLOW_EXIT.load(Ordering::SeqCst) {
                            if let Some(w) = handle.get_window("main") {
                                let _ = w.hide();
                            }
                            api.prevent_close();
                        }
                    }
                    tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        reposition_all(&handle);
                    }
                    _ => {}
                });
            }

            // macOS: own Quit + Cmd+Q via app.exit. The system terminate path
            // (default Quit) only fires CloseRequested — prevent_close would
            // cancel quit and leave the process stuck.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

                let quit_i =
                    MenuItem::with_id(app, "quit", "Quit Tendencys", true, Some("CmdOrCtrl+Q"))?;
                let app_submenu = Submenu::with_items(
                    app,
                    "Tendencys",
                    true,
                    &[
                        &PredefinedMenuItem::about(
                            app,
                            Some("About Tendencys"),
                            Some(AboutMetadata::default()),
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::services(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &quit_i,
                    ],
                )?;
                let edit_submenu = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                let menu = Menu::with_items(app, &[&app_submenu, &edit_submenu])?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        request_quit(app);
                    }
                });
            }

            // Windows/Linux: after X there is no Dock — tray Show/Quit is the
            // Slack affordance. macOS uses Dock reopen + app menu Quit instead.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show_i = MenuItem::with_id(app, "show", "Show Tendencys", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit Tendencys", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("missing default window icon for tray")?;
                let tray = TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .menu(&menu)
                    .tooltip("Tendencys")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => focus_main_window(app),
                        "quit" => request_quit(app),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            focus_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
                // Keep a managed ref — TrayIcon is removed when the last clone drops.
                app.manage(tray);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                ALLOW_EXIT.store(true, Ordering::SeqCst);
            }
            // macOS Dock click when no windows are visible.
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                focus_main_window(app_handle);
            }
            _ => {}
        });
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
