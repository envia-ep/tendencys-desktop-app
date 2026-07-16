use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

/// Device keys are stored as local files (not the OS Keychain/Credential
/// Manager). The OS Keychain requires a per-item "Always Allow" consent
/// dialog on first access — unacceptable UX for a silent "remember me"
/// convenience token. Protection instead comes from OS file permissions
/// (0600 on Unix; already user-scoped %APPDATA% on Windows), the same model
/// used by tools like `gh`, `docker`, and `npm` for local auth tokens.
const META_DIR: &str = "device-keys";

/// Only these hosts may receive session tokens / device-key auth traffic.
const ALLOWED_ACCOUNTS_HOSTS: &[&str] = &[
    "accounts-sandbox.envia.com",
    "accounts.envia.com",
    "accounts.ecart.com",
    "accounts-sandbox.ecartpay.com",
    "accounts-test.ecart.com",
    "accounts-stage.ecart.com",
    "localhost",
    "127.0.0.1",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeyMeta {
    pub device_id: String,
    pub public_key: String,
    pub platform: String,
    pub device_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
}

fn resolve_accounts_base(accounts_base_url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(accounts_base_url.trim())
        .map_err(|e| format!("invalid accounts url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "accounts url missing host".to_string())?;
    if !ALLOWED_ACCOUNTS_HOSTS.contains(&host) {
        return Err(format!("accounts host not allowed: {host}"));
    }
    let is_local = host == "localhost" || host == "127.0.0.1";
    if !is_local && parsed.scheme() != "https" {
        return Err("accounts url must use https".into());
    }
    if is_local && parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("local accounts url must use http or https".into());
    }
    let mut base = parsed;
    base.set_path("");
    base.set_query(None);
    base.set_fragment(None);
    Ok(base.as_str().trim_end_matches('/').to_string())
}

/// Accounts' Cloudflare zone challenges `reqwest`'s TLS/HTTP2 fingerprint on
/// `/api/device-keys/*` (curl is never challenged, even with identical
/// headers), so this shells out to the system `curl` binary for that one
/// call so device-key registration can complete. Headers/body go through a
/// `-K` config file (mode 0600, deleted immediately after) so the session
/// token and public key never appear in `ps` output.
fn curl_json_post(url: &str, headers: &[(&str, &str)], body: &serde_json::Value) -> Result<(u16, String), String> {
    use std::io::Write;

    let body_path = std::env::temp_dir().join(format!("tdk-body-{}.json", Uuid::new_v4()));
    fs::write(&body_path, body.to_string()).map_err(|e| format!("curl body write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&body_path, fs::Permissions::from_mode(0o600));
    }

    let mut cfg = String::new();
    cfg.push_str("request = \"POST\"\n");
    cfg.push_str(&format!("url = \"{}\"\n", url.replace('"', "\\\"")));
    cfg.push_str("header = \"Content-Type: application/json\"\n");
    for (k, v) in headers {
        cfg.push_str(&format!(
            "header = \"{}: {}\"\n",
            k,
            v.replace('"', "\\\"")
        ));
    }
    cfg.push_str(&format!(
        "data-binary = \"@{}\"\n",
        body_path.display()
    ));
    cfg.push_str("silent\nshow-error\n");
    cfg.push_str("write-out = \"\\n%{http_code}\"\n");

    let cfg_path = std::env::temp_dir().join(format!("tdk-curl-{}.cfg", Uuid::new_v4()));
    {
        let mut f = fs::File::create(&cfg_path).map_err(|e| format!("curl cfg write: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
        }
        f.write_all(cfg.as_bytes())
            .map_err(|e| format!("curl cfg write: {e}"))?;
    }

    let output = std::process::Command::new("curl")
        .arg("-K")
        .arg(&cfg_path)
        .output();

    let _ = fs::remove_file(&cfg_path);
    let _ = fs::remove_file(&body_path);

    let output = output.map_err(|e| format!("curl exec: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut lines: Vec<&str> = stdout.lines().collect();
    let status_line = lines.pop().unwrap_or("0");
    let status: u16 = status_line.trim().parse().unwrap_or(0);
    let body_text = lines.join("\n");
    Ok((status, body_text))
}

fn require_account_id(account_id: &str) -> Result<&str, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("account_id required".into());
    }
    // Prevent path traversal in meta filenames.
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("invalid account_id".into());
    }
    Ok(trimmed)
}

fn meta_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join(META_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create device-keys dir: {e}"))?;
    Ok(dir)
}

fn meta_path(app: &tauri::AppHandle, account_id: &str) -> Result<PathBuf, String> {
    let id = require_account_id(account_id)?;
    Ok(meta_dir(app)?.join(format!("{id}.json")))
}

fn key_path(app: &tauri::AppHandle, account_id: &str) -> Result<PathBuf, String> {
    let id = require_account_id(account_id)?;
    Ok(meta_dir(app)?.join(format!("{id}.key")))
}

/// Write the base64-encoded private key to a local file with owner-only
/// permissions. On Unix this sets mode 0600 explicitly; on Windows the
/// per-user app-data directory is already ACL-restricted to the current user.
fn write_key_file(path: &PathBuf, secret_b64: &str) -> Result<(), String> {
    fs::write(path, secret_b64).map_err(|e| format!("write device key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod device key: {e}"))?;
    }
    Ok(())
}

fn read_key_file(path: &PathBuf) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read device key: {e}"))?;
    Ok(Some(raw.trim().to_string()))
}

fn platform_name() -> String {
    match std::env::consts::OS {
        "macos" => "macos".into(),
        "windows" => "windows".into(),
        "linux" => "linux".into(),
        other => other.into(),
    }
}

fn device_label() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "Tendencys Desktop".into())
}

/// Pre-multi-account (and pre-file-storage) legacy device key can only have
/// lived in the OS Keychain. There is no supported migration path off of it
/// anymore (the feature never shipped to real users) — a stale legacy meta
/// file with no matching key file is simply treated as "no device key" and
/// the caller falls back to interactive login, which re-registers a fresh
/// file-backed key.
fn load_signing_key(app: &tauri::AppHandle, account_id: &str) -> Result<SigningKey, String> {
    let path = key_path(app, account_id)?;
    let secret_b64 = read_key_file(&path)?.ok_or_else(|| "no device key file".to_string())?;
    let secret_bytes = B64
        .decode(secret_b64.trim())
        .map_err(|e| format!("decode private key: {e}"))?;
    let secret_array: [u8; 32] = secret_bytes
        .try_into()
        .map_err(|_| "private key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&secret_array))
}

fn read_meta(app: &tauri::AppHandle, account_id: &str) -> Result<Option<DeviceKeyMeta>, String> {
    let path = meta_path(app, account_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
    let meta: DeviceKeyMeta =
        serde_json::from_str(&raw).map_err(|e| format!("parse meta: {e}"))?;
    Ok(Some(meta))
}

fn write_meta(app: &tauri::AppHandle, account_id: &str, meta: &DeviceKeyMeta) -> Result<(), String> {
    let path = meta_path(app, account_id)?;
    let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize meta: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write meta: {e}"))
}

fn sign_challenge_bytes(
    app: &tauri::AppHandle,
    account_id: &str,
    challenge: &str,
) -> Result<String, String> {
    let signing_key = load_signing_key(app, account_id)?;
    let signature = signing_key.sign(challenge.as_bytes());
    Ok(B64.encode(signature.to_bytes()))
}

/// Log a JWT's claim shape under `[sso]` for diagnostics. NEVER logs the raw
/// token — only whether it carries the `id` that `/api/device-keys/register`
/// requires, plus its `aud`. Best-effort: undecodable tokens log a length only.
fn log_register_token_shape(token: &str) {
    let payload = token
        .split('.')
        .nth(1)
        .and_then(|seg| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(seg).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    match payload {
        Some(json) => {
            let has_id = json.get("id").map(|v| !v.is_null()).unwrap_or(false);
            let aud = json.get("aud").and_then(|v| v.as_str());
            log::info!("[sso] register token hasId={has_id} aud={aud:?} len={}", token.len());
        }
        None => log::info!("[sso] register token undecodable len={}", token.len()),
    }
}

#[tauri::command]
pub fn has_device_key(app: tauri::AppHandle, account_id: String) -> Result<bool, String> {
    if read_meta(&app, &account_id)?.is_none() {
        return Ok(false);
    }
    let path = key_path(&app, &account_id)?;
    let result = read_key_file(&path).map(|opt| opt.is_some());
    Ok(result.unwrap_or(false))
}

#[tauri::command]
pub fn get_device_key_meta(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<Option<DeviceKeyMeta>, String> {
    read_meta(&app, &account_id)
}

#[tauri::command]
pub fn generate_device_keypair(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<DeviceKeyMeta, String> {
    let id = require_account_id(&account_id)?.to_string();
    let key_file = key_path(&app, &id)?;
    if let Some(existing) = read_meta(&app, &id)? {
        if read_key_file(&key_file)?.is_some() {
            return Ok(existing);
        }
    }

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let public_key = B64.encode(verifying_key.as_bytes());
    let private_b64 = B64.encode(signing_key.to_bytes());

    write_key_file(&key_file, &private_b64)?;

    let meta = DeviceKeyMeta {
        device_id: Uuid::new_v4().to_string(),
        public_key,
        platform: platform_name(),
        device_label: device_label(),
        method_id: None,
    };
    write_meta(&app, &id, &meta)?;
    Ok(meta)
}

#[tauri::command]
pub fn set_device_key_method_id(
    app: tauri::AppHandle,
    account_id: String,
    method_id: String,
) -> Result<(), String> {
    let id = require_account_id(&account_id)?.to_string();
    let mut meta = read_meta(&app, &id)?.ok_or_else(|| "device key meta missing".to_string())?;
    meta.method_id = Some(method_id);
    write_meta(&app, &id, &meta)
}

#[tauri::command]
pub fn delete_device_key(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    let id = require_account_id(&account_id)?.to_string();
    let key_file = key_path(&app, &id)?;
    if key_file.exists() {
        let _ = fs::remove_file(&key_file);
    }
    let path = meta_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove meta: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct OptionsResponse {
    challenge: String,
}

/// Encode a 429 so the TS layer can detect it and back off instead of retrying.
/// Shape: `RATE_LIMITED|<retry-after-seconds-or-empty>|<raw-body>`. The body may
/// be JSON (app-level 429) or HTML (Cloudflare edge 429) — TS parses defensively.
fn rate_limited_err(headers: &reqwest::header::HeaderMap, body: &str) -> String {
    let retry_after = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    format!("RATE_LIMITED|{retry_after}|{body}")
}

#[derive(Serialize)]
struct LoginBody<'a> {
    token: &'a str,
    device_id: &'a str,
    challenge: &'a str,
    signature: &'a str,
}

#[tauri::command]
pub async fn login_with_device_key(
    app: tauri::AppHandle,
    account_id: String,
    accounts_base_url: String,
    site_id: String,
    redirect_url_b64: String,
) -> Result<serde_json::Value, String> {
    let id = require_account_id(&account_id)?.to_string();
    let base = resolve_accounts_base(&accounts_base_url)?;
    let meta = read_meta(&app, &id)?.ok_or_else(|| "no device key".to_string())?;
    let client = reqwest::Client::new();

    let options_url = format!(
        "{}/api/device-keys/authentication/options?device_id={}",
        base,
        urlencoding::encode(&meta.device_id)
    );
    let options_res = client
        .get(&options_url)
        .send()
        .await
        .map_err(|e| format!("options request: {e}"))?;
    let options_status = options_res.status();
    let options_headers = options_res.headers().clone();
    let options_body_text = options_res.text().await.unwrap_or_default();
    if !options_status.is_success() {
        if options_status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(rate_limited_err(&options_headers, &options_body_text));
        }
        return Err(format!("options failed ({options_status}): {options_body_text}"));
    }
    let options: OptionsResponse = serde_json::from_str(&options_body_text)
        .map_err(|e| format!("options parse: {e}"))?;

    let signature = sign_challenge_bytes(&app, &id, &options.challenge)?;

    let referer = format!(
        "{}/login?site_id={}&redirect_url={}",
        base,
        urlencoding::encode(&site_id),
        urlencoding::encode(&redirect_url_b64)
    );
    let login_url = format!("{}/api/login/device-key", base);
    let login_res = client
        .post(&login_url)
        .header("Authorization", "Bearer device-key")
        .header("Content-Type", "application/json")
        .header("Referer", &referer)
        .json(&LoginBody {
            token: "",
            device_id: &meta.device_id,
            challenge: &options.challenge,
            signature: &signature,
        })
        .send()
        .await
        .map_err(|e| format!("login request: {e}"))?;

    let status = login_res.status();
    let headers = login_res.headers().clone();
    let body_text = login_res
        .text()
        .await
        .map_err(|e| format!("login read: {e}"))?;
    if !status.is_success() {
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(rate_limited_err(&headers, &body_text));
        }
        return Err(format!("login failed ({status}): {body_text}"));
    }
    let body: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("login parse: {e}"))?;
    Ok(body)
}

#[tauri::command]
pub async fn register_device_key(
    app: tauri::AppHandle,
    account_id: String,
    accounts_base_url: String,
    session_token: String,
    referer: String,
) -> Result<DeviceKeyMeta, String> {
    let id = require_account_id(&account_id)?.to_string();
    let base = resolve_accounts_base(&accounts_base_url)?;
    let meta = generate_device_keypair(app.clone(), id.clone())?;
    let url = format!("{}/api/device-keys/register", base);

    // Diagnostics: `/api/device-keys/register` needs a token with a valid `id`
    // (the `/api/accounts/authorization` token has none — hence prior 401s).
    log_register_token_shape(&session_token);

    // Accounts' jsonwebtoken middleware rejects the session token unless the
    // Referer echoes its `aud` (= HOSTNAME). The caller passes the token's
    // decoded audience so this matches regardless of HOSTNAME formatting.
    let register_body = serde_json::json!({
        "device_id": meta.device_id,
        "public_key": meta.public_key,
        "algorithm": "ed25519",
        "platform": meta.platform,
        "client": "desktop",
        "app_id": "tendencys-desktop",
        "device_label": meta.device_label,
    });
    let (status_u16, body_text) = curl_json_post(
        &url,
        &[
            ("Authorization", &session_token),
            ("Referer", &referer),
        ],
        &register_body,
    )?;
    let status = reqwest::StatusCode::from_u16(status_u16)
        .map_err(|e| format!("register: bad status {status_u16}: {e}"))?;
    let body: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("register parse: {e} (status={status}, body={body_text})"))?;
    log::info!("[sso] register status={status} ok={}", status.is_success());
    if !status.is_success() {
        log::info!("[sso] register error body={}", body);
        // Per-account keys: if this device_id is already registered for another
        // reason, rotate only this account's local key and retry once.
        let body_str = body.to_string();
        if body_str.to_lowercase().contains("already registered") {
            delete_device_key(app.clone(), id.clone())?;
            let meta = generate_device_keypair(app.clone(), id.clone())?;
            let retry_body = serde_json::json!({
                "device_id": meta.device_id,
                "public_key": meta.public_key,
                "algorithm": "ed25519",
                "platform": meta.platform,
                "client": "desktop",
                "app_id": "tendencys-desktop",
                "device_label": meta.device_label,
            });
            let (retry_status_u16, retry_body_text) = curl_json_post(
                &url,
                &[
                    ("Authorization", &session_token),
                    ("Referer", &referer),
                ],
                &retry_body,
            )?;
            let status = reqwest::StatusCode::from_u16(retry_status_u16)
                .map_err(|e| format!("register retry: bad status {retry_status_u16}: {e}"))?;
            let body: serde_json::Value = serde_json::from_str(&retry_body_text)
                .map_err(|e| format!("register retry parse: {e}"))?;
            if !status.is_success() {
                return Err(format!(
                    "register failed ({status}): {}",
                    body.to_string()
                ));
            }
            let method_id = body
                .get("doc")
                .and_then(|d| d.get("_id").or_else(|| d.get("id")))
                .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string());
            let mut updated = meta;
            if let Some(mid) = method_id {
                updated.method_id = Some(mid.clone());
                set_device_key_method_id(app, id, mid)?;
            }
            return Ok(updated);
        }
        return Err(format!(
            "register failed ({status}): {}",
            body.to_string()
        ));
    }

    let method_id = body
        .get("doc")
        .and_then(|d| d.get("_id").or_else(|| d.get("id")))
        .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string());

    let mut updated = meta;
    if let Some(mid) = method_id {
        updated.method_id = Some(mid.clone());
        set_device_key_method_id(app, id, mid)?;
    }
    Ok(updated)
}
