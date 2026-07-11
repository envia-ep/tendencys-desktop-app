use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use keyring::Entry;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "tendencys-desktop";
const KEYRING_USER: &str = "device-key";
const META_FILE: &str = "device-key-meta.json";

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

fn meta_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(META_FILE))
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

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring: {e}"))
}

fn load_signing_key() -> Result<SigningKey, String> {
    let entry = keyring_entry()?;
    let secret_b64 = entry
        .get_password()
        .map_err(|e| format!("keyring read: {e}"))?;
    let secret_bytes = B64
        .decode(secret_b64.trim())
        .map_err(|e| format!("decode private key: {e}"))?;
    let secret_array: [u8; 32] = secret_bytes
        .try_into()
        .map_err(|_| "private key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&secret_array))
}

fn read_meta(app: &tauri::AppHandle) -> Result<Option<DeviceKeyMeta>, String> {
    let path = meta_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
    let meta: DeviceKeyMeta =
        serde_json::from_str(&raw).map_err(|e| format!("parse meta: {e}"))?;
    Ok(Some(meta))
}

fn write_meta(app: &tauri::AppHandle, meta: &DeviceKeyMeta) -> Result<(), String> {
    let path = meta_path(app)?;
    let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize meta: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write meta: {e}"))
}

fn sign_challenge_bytes(challenge: &str) -> Result<String, String> {
    let signing_key = load_signing_key()?;
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
pub fn has_device_key(app: tauri::AppHandle) -> Result<bool, String> {
    if read_meta(&app)?.is_none() {
        return Ok(false);
    }
    Ok(keyring_entry()
        .and_then(|e| e.get_password().map(|_| true).map_err(|err| err.to_string()))
        .unwrap_or(false))
}

#[tauri::command]
pub fn get_device_key_meta(app: tauri::AppHandle) -> Result<Option<DeviceKeyMeta>, String> {
    read_meta(&app)
}

#[tauri::command]
pub fn generate_device_keypair(app: tauri::AppHandle) -> Result<DeviceKeyMeta, String> {
    if let Some(existing) = read_meta(&app)? {
        if keyring_entry()
            .and_then(|e| e.get_password().map_err(|err| err.to_string()))
            .is_ok()
        {
            return Ok(existing);
        }
    }

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let public_key = B64.encode(verifying_key.as_bytes());
    let private_b64 = B64.encode(signing_key.to_bytes());

    keyring_entry()?
        .set_password(&private_b64)
        .map_err(|e| format!("keyring write: {e}"))?;

    let meta = DeviceKeyMeta {
        device_id: Uuid::new_v4().to_string(),
        public_key,
        platform: platform_name(),
        device_label: device_label(),
        method_id: None,
    };
    write_meta(&app, &meta)?;
    Ok(meta)
}

#[tauri::command]
pub fn set_device_key_method_id(app: tauri::AppHandle, method_id: String) -> Result<(), String> {
    let mut meta = read_meta(&app)?.ok_or_else(|| "device key meta missing".to_string())?;
    meta.method_id = Some(method_id);
    write_meta(&app, &meta)
}

#[tauri::command]
pub fn delete_device_key(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    let path = meta_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove meta: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct OptionsResponse {
    challenge: String,
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
    accounts_base_url: String,
    site_id: String,
    redirect_url_b64: String,
) -> Result<serde_json::Value, String> {
    let base = resolve_accounts_base(&accounts_base_url)?;
    let meta = read_meta(&app)?.ok_or_else(|| "no device key".to_string())?;
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
    if !options_res.status().is_success() {
        let status = options_res.status();
        let body = options_res.text().await.unwrap_or_default();
        return Err(format!("options failed ({status}): {body}"));
    }
    let options: OptionsResponse = options_res
        .json()
        .await
        .map_err(|e| format!("options parse: {e}"))?;

    let signature = sign_challenge_bytes(&options.challenge)?;

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
    let body: serde_json::Value = login_res
        .json()
        .await
        .map_err(|e| format!("login parse: {e}"))?;
    if !status.is_success() {
        return Err(format!("login failed ({status}): {}", body.to_string()));
    }
    Ok(body)
}

#[tauri::command]
pub async fn register_device_key(
    app: tauri::AppHandle,
    accounts_base_url: String,
    session_token: String,
    referer: String,
) -> Result<DeviceKeyMeta, String> {
    let base = resolve_accounts_base(&accounts_base_url)?;
    let meta = generate_device_keypair(app.clone())?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/device-keys/register", base);

    // Diagnostics: `/api/device-keys/register` needs a token with a valid `id`
    // (the `/api/accounts/authorization` token has none — hence prior 401s).
    log_register_token_shape(&session_token);

    // Accounts' jsonwebtoken middleware rejects the session token unless the
    // Referer echoes its `aud` (= HOSTNAME). The caller passes the token's
    // decoded audience so this matches regardless of HOSTNAME formatting.
    let res = client
        .post(&url)
        .header("Authorization", &session_token)
        .header("Content-Type", "application/json")
        .header("Referer", &referer)
        .json(&serde_json::json!({
            "device_id": meta.device_id,
            "public_key": meta.public_key,
            "algorithm": "ed25519",
            "platform": meta.platform,
            "client": "desktop",
            "app_id": "tendencys-desktop",
            "device_label": meta.device_label,
        }))
        .send()
        .await
        .map_err(|e| format!("register request: {e}"))?;

    let status = res.status();
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("register parse: {e}"))?;
    log::info!("[sso] register status={status} ok={}", status.is_success());
    if !status.is_success() {
        log::info!("[sso] register error body={}", body);
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
    if let Some(id) = method_id {
        updated.method_id = Some(id.clone());
        set_device_key_method_id(app, id)?;
    }
    Ok(updated)
}
