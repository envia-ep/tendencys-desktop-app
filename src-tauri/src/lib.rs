mod device_key;
mod webview_manager;

use device_key::{
    delete_device_key, generate_device_keypair, get_device_key_meta, has_device_key,
    login_with_device_key, register_device_key, set_device_key_method_id,
};
use webview_manager::{
    clear_accounts_session, close_shell_login, logout_webviews, navigate_service, open_shell_login,
    prewarm_service, read_accounts_session, reload_service, reposition_all, seed_accounts_session,
    select_service, service_history_back, service_history_forward, set_content_left_inset,
    set_service_visible, ServiceWebviews,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

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
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
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
