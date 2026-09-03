use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::process_util::output_hidden;

const META_DIR: &str = "jarvis-device-keys";
const CLIPBOARD_KINDS: &[&str] = &["ONCE", "SESSION", "15_MIN"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisIdentity {
    pub device_id: String,
    pub public_key: String,
    pub attestation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisEnvelope {
    pub tool_invocation_id: String,
    pub request_id: String,
    pub run_id: String,
    pub session_id: String,
    pub device_id: String,
    pub tool: String,
    pub tool_version: u32,
    pub grant_id: Option<String>,
    pub arguments: Value,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce: String,
    pub server_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedToolResult {
    pub status: String,
    pub result: Value,
    pub executed_at: String,
    pub device_signature: String,
    pub tool_invocation_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGrant {
    pub grant_id: String,
    pub capability: String,
    pub kind: Option<String>,
    pub local_root: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Default)]
pub struct JarvisBridgeState {
    used_nonces: HashSet<String>,
    executed: HashMap<String, SignedToolResult>,
    grants: HashMap<String, LocalGrant>,
    server_public_key: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_iso_secs(value: &str) -> Option<i64> {
    // Accept RFC3339-ish `2026-08-15T10:00:00.000Z` by reading the unix-ish prefix.
    // Full chrono is not a dependency; expire checks use file mtime-quality parsing.
    let trimmed = value.trim().trim_end_matches('Z');
    let date = trimmed.get(0..10)?;
    let time = trimmed.get(11..19)?;
    let (y, mo, d) = (
        date.get(0..4)?.parse::<i64>().ok()?,
        date.get(5..7)?.parse::<i64>().ok()?,
        date.get(8..10)?.parse::<i64>().ok()?,
    );
    let (h, mi, s) = (
        time.get(0..2)?.parse::<i64>().ok()?,
        time.get(3..5)?.parse::<i64>().ok()?,
        time.get(6..8)?.parse::<i64>().ok()?,
    );
    Some(((y - 1970) * 365 + mo * 30 + d) * 86400 + h * 3600 + mi * 60 + s)
}

fn grant_expired(grant: &LocalGrant) -> bool {
    if grant.revoked_at.is_some() {
        return true;
    }
    match &grant.expires_at {
        Some(exp) => parse_iso_secs(exp).is_some_and(|secs| secs < now_secs() - 120),
        None => false,
    }
}

fn meta_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join(META_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create jarvis-device-keys: {e}"))?;
    Ok(dir)
}

fn write_key_file(path: &PathBuf, secret_b64: &str) -> Result<(), String> {
    fs::write(path, secret_b64).map_err(|e| format!("write jarvis key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod jarvis key: {e}"))?;
    }
    Ok(())
}

fn load_or_create_signing_key(
    app: &tauri::AppHandle,
) -> Result<(SigningKey, String, String), String> {
    let dir = meta_dir(app)?;
    let key_path = dir.join("device.key");
    let meta_path = dir.join("device.json");
    if key_path.exists() && meta_path.exists() {
        let secret_b64 =
            fs::read_to_string(&key_path).map_err(|e| format!("read jarvis key: {e}"))?;
        let secret = B64
            .decode(secret_b64.trim())
            .map_err(|e| format!("decode jarvis key: {e}"))?;
        let secret_array: [u8; 32] = secret
            .try_into()
            .map_err(|_| "jarvis private key must be 32 bytes".to_string())?;
        let signing = SigningKey::from_bytes(&secret_array);
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&meta_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let device_id = meta
            .get("deviceId")
            .and_then(|v| v.as_str())
            .ok_or("missing deviceId")?
            .to_string();
        let public_key = B64.encode(signing.verifying_key().as_bytes());
        return Ok((signing, device_id, public_key));
    }
    let signing = SigningKey::generate(&mut OsRng);
    let public_key = B64.encode(signing.verifying_key().as_bytes());
    let device_id = format!("jdv_{}", Uuid::new_v4());
    write_key_file(&key_path, &B64.encode(signing.to_bytes()))?;
    fs::write(
        &meta_path,
        serde_json::json!({ "deviceId": device_id, "publicKey": public_key }).to_string(),
    )
    .map_err(|e| format!("write jarvis meta: {e}"))?;
    Ok((signing, device_id, public_key))
}

fn sign_bytes(signing: &SigningKey, data: &[u8]) -> String {
    B64.encode(signing.sign(data).to_bytes())
}

fn verify_ed25519(public_b64: &str, data: &[u8], signature_b64: &str) -> Result<(), String> {
    let raw = B64
        .decode(public_b64)
        .map_err(|e| format!("decode server public key: {e}"))?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| "server public key must be 32 bytes".to_string())?;
    let verifying = VerifyingKey::from_bytes(&bytes).map_err(|e| e.to_string())?;
    let sig_raw = B64
        .decode(signature_b64)
        .map_err(|e| format!("decode signature: {e}"))?;
    let sig_bytes: [u8; 64] = sig_raw
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_bytes);
    verifying
        .verify(data, &signature)
        .map_err(|_| "invalid server signature".to_string())
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
        Value::Array(items) => {
            format!(
                "[{}]",
                items
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            let body = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(&key).unwrap(),
                        canonical_json(&map[&key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn envelope_bytes(envelope: &JarvisEnvelope) -> Vec<u8> {
    let args_hash = sha256_hex(&canonical_json(&envelope.arguments));
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        envelope.tool_invocation_id,
        envelope.request_id,
        envelope.run_id,
        envelope.session_id,
        envelope.device_id,
        envelope.tool,
        envelope.tool_version,
        envelope.grant_id.clone().unwrap_or_default(),
        args_hash,
        envelope.issued_at,
        envelope.expires_at,
        envelope.nonce
    )
    .into_bytes()
}

fn result_sign_bytes(
    run_id: &str,
    tool_invocation_id: &str,
    request_id: &str,
    status: &str,
    result: &Value,
    executed_at: &str,
) -> Vec<u8> {
    let digest = sha256_hex(&format!(
        "{run_id}{tool_invocation_id}{request_id}{status}{}{executed_at}",
        sha256_hex(&canonical_json(result))
    ));
    digest.into_bytes()
}

fn is_relative_safe(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute() && !path.split(['/', '\\']).any(|part| part == "..")
}

pub fn resolve_under_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !is_relative_safe(relative) {
        return Err("relative path required".into());
    }
    let joined = root.join(relative);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("canonicalize root: {e}"))?;
    if !joined.exists() {
        return Err("file not found".into());
    }
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("canonicalize path: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("path escapes grant root".into());
    }
    Ok(canon)
}

fn clipboard_read() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let output = output_hidden(Command::new("pbpaste")).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let output = output_hidden({
        let mut cmd = Command::new("xclip");
        cmd.args(["-selection", "clipboard", "-o"]);
        cmd
    })
    .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let output = output_hidden({
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Get-Clipboard"]);
        cmd
    })
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("clipboard read failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn clipboard_write(content: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .ok_or("pbcopy stdin")?
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        child.wait().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = content;
        Err("clipboard write not implemented on this OS in phase 1".into())
    }
}

fn notify_show(title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            body.replace('"', "'"),
            title.replace('"', "'")
        );
        let _ = output_hidden({
            let mut cmd = Command::new("osascript");
            cmd.args(["-e", &script]);
            cmd
        });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Ok(())
    }
}

fn execute_tool(state: &mut JarvisBridgeState, envelope: &JarvisEnvelope) -> Result<Value, String> {
    match envelope.tool.as_str() {
        "clipboard.read" => {
            require_grant(state, envelope, "clipboard.read")?;
            Ok(serde_json::json!({ "text": clipboard_read()? }))
        }
        "clipboard.write" => {
            let content = envelope
                .arguments
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            clipboard_write(content)?;
            Ok(serde_json::json!({ "written": true }))
        }
        "notify.show" => {
            let title = envelope
                .arguments
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Jarvis");
            let body = envelope
                .arguments
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            notify_show(title, body)?;
            Ok(serde_json::json!({ "shown": true }))
        }
        "files.list" | "files.read" => {
            let root = require_grant(state, envelope, &envelope.tool)?
                .local_root
                .clone()
                .ok_or("folder grant missing local root")?;
            let rel = envelope
                .arguments
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or(".")
                .to_string();
            let path = resolve_under_root(Path::new(&root), &rel)?;
            if envelope.tool == "files.list" {
                let mut names = Vec::new();
                for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                    names.push(
                        entry
                            .map_err(|e| e.to_string())?
                            .file_name()
                            .to_string_lossy()
                            .to_string(),
                    );
                }
                Ok(serde_json::json!({ "entries": names }))
            } else {
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({
                    "path": rel,
                    "text": String::from_utf8_lossy(&bytes),
                }))
            }
        }
        other => Err(format!("native tool not implemented: {other}")),
    }
}

fn require_grant<'a>(
    state: &'a mut JarvisBridgeState,
    envelope: &JarvisEnvelope,
    capability: &str,
) -> Result<&'a LocalGrant, String> {
    let grant_id = envelope
        .grant_id
        .as_deref()
        .ok_or("grant required for this tool")?;
    let grant = state.grants.get(grant_id).ok_or("unknown grant")?;
    if grant.capability != capability {
        return Err("grant capability mismatch".into());
    }
    if grant_expired(grant) {
        return Err("grant expired".into());
    }
    if capability.starts_with("clipboard") {
        if grant.expires_at.is_none() {
            return Err("clipboard grants cannot be always".into());
        }
        if let Some(kind) = &grant.kind {
            if !CLIPBOARD_KINDS.contains(&kind.as_str()) {
                return Err("clipboard grants must be ONCE, SESSION, or 15_MIN".into());
            }
        }
    }
    Ok(state.grants.get(grant_id).unwrap())
}

#[tauri::command]
pub fn jarvis_device_identity(app: tauri::AppHandle) -> Result<JarvisIdentity, String> {
    let (signing, device_id, public_key) = load_or_create_signing_key(&app)?;
    let attestation = sign_bytes(&signing, format!("{device_id}|{public_key}").as_bytes());
    Ok(JarvisIdentity {
        device_id,
        public_key,
        attestation,
    })
}

#[tauri::command]
pub fn jarvis_pin_server_key(
    state: tauri::State<'_, Mutex<JarvisBridgeState>>,
    public_key: String,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = &guard.server_public_key {
        if existing != &public_key {
            return Err("server public key already pinned".into());
        }
        return Ok(());
    }
    guard.server_public_key = Some(public_key);
    Ok(())
}

#[tauri::command]
pub fn jarvis_upsert_grant(
    state: tauri::State<'_, Mutex<JarvisBridgeState>>,
    grant: LocalGrant,
) -> Result<LocalGrant, String> {
    if grant.capability.starts_with("clipboard") {
        if grant.expires_at.is_none() {
            return Err("clipboard grants cannot be always".into());
        }
        if grant
            .kind
            .as_deref()
            .is_none_or(|kind| !CLIPBOARD_KINDS.contains(&kind))
        {
            return Err("clipboard grants must be ONCE, SESSION, or 15_MIN".into());
        }
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.grants.insert(grant.grant_id.clone(), grant.clone());
    Ok(grant)
}

#[tauri::command]
pub fn jarvis_revoke_grant(
    state: tauri::State<'_, Mutex<JarvisBridgeState>>,
    grant_id: String,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(grant) = guard.grants.get_mut(&grant_id) {
        grant.revoked_at = Some(chrono_now());
    }
    Ok(())
}

fn chrono_now() -> String {
    let secs = now_secs();
    format!("{secs}")
}

#[tauri::command]
pub fn jarvis_sign_tool_result(
    app: tauri::AppHandle,
    run_id: String,
    tool_invocation_id: String,
    request_id: String,
    status: String,
    result: Value,
) -> Result<SignedToolResult, String> {
    let (signing, _, _) = load_or_create_signing_key(&app)?;
    let executed_at = format!("{}Z", now_secs());
    let signature = sign_bytes(
        &signing,
        &result_sign_bytes(
            &run_id,
            &tool_invocation_id,
            &request_id,
            &status,
            &result,
            &executed_at,
        ),
    );
    Ok(SignedToolResult {
        status,
        result,
        executed_at,
        device_signature: signature,
        tool_invocation_id,
        request_id,
    })
}

#[tauri::command]
pub fn jarvis_execute_envelope(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<JarvisBridgeState>>,
    envelope: JarvisEnvelope,
) -> Result<SignedToolResult, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.executed.get(&envelope.tool_invocation_id) {
        return Ok(existing.clone());
    }
    if !guard.used_nonces.insert(envelope.nonce.clone()) {
        return Err("replayed nonce".into());
    }
    let server_key = guard
        .server_public_key
        .clone()
        .ok_or("server public key is not pinned")?;
    verify_ed25519(
        &server_key,
        &envelope_bytes(&envelope),
        &envelope.server_signature,
    )?;
    if parse_iso_secs(&envelope.expires_at).is_some_and(|exp| exp + 120 < now_secs()) {
        return Err("envelope expired".into());
    }
    let result = match execute_tool(&mut guard, &envelope) {
        Ok(value) => value,
        Err(err) => serde_json::json!({ "error": err }),
    };
    let status = if result.get("error").is_some() {
        "failed"
    } else {
        "succeeded"
    };
    drop(guard);
    let signed = jarvis_sign_tool_result(
        app,
        envelope.run_id,
        envelope.tool_invocation_id.clone(),
        envelope.request_id.clone(),
        status.to_string(),
        result,
    )?;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard
        .executed
        .insert(envelope.tool_invocation_id.clone(), signed.clone());
    if envelope.tool == "clipboard.read" {
        if let Some(grant_id) = &envelope.grant_id {
            if let Some(grant) = guard.grants.get_mut(grant_id) {
                if grant.kind.as_deref() == Some("ONCE") {
                    grant.revoked_at = Some(chrono_now());
                }
            }
        }
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let tmp = std::env::temp_dir().join(format!("jarvis-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("ok.txt"), "hi").unwrap();
        assert!(resolve_under_root(&tmp, "ok.txt").is_ok());
        assert!(resolve_under_root(&tmp, "../ok.txt").is_err());
        assert!(resolve_under_root(&tmp, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clipboard_kind_allowlist() {
        assert!(CLIPBOARD_KINDS.contains(&"ONCE"));
        assert!(CLIPBOARD_KINDS.contains(&"SESSION"));
        assert!(CLIPBOARD_KINDS.contains(&"15_MIN"));
        assert!(!CLIPBOARD_KINDS.contains(&"ALWAYS"));
    }
}
