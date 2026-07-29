//! Multi-factor machine fingerprint for device trust (blacklist / multi-account).
//!
//! Persists a stable hash under `{app_data}/device-keys/machine.json`. Only the
//! hash + version are stored/sent — never raw hardware IDs in logs.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const FINGERPRINT_VERSION: &str = "v1";
const MACHINE_FILE: &str = "machine.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFingerprint {
    pub fingerprint: String,
    pub version: String,
    pub created_at: String,
}

/// Hash factors into a hex sha256. Pure — used by tests and collectors.
pub fn hash_machine_fingerprint(hardware_id: &str, mac: &str, hostname: &str) -> String {
    let input = format!(
        "{}|{}|{}|{}",
        FINGERPRINT_VERSION, hardware_id, mac, hostname
    );
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(digest)
}

fn hostname_factor() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_default()
}

fn primary_mac() -> String {
    match mac_address::get_mac_address() {
        Ok(Some(ma)) => ma.to_string().to_ascii_lowercase(),
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
fn hardware_id() -> String {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok();
    let Some(output) = output else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains("IOPlatformUUID") {
            continue;
        }
        if let Some(idx) = line.rfind('=') {
            let value = line[idx + 1..].trim().trim_matches('"').trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
fn hardware_id() -> String {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok();
    let Some(output) = output else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains("MachineGuid") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(guid) = parts.last() {
            if !guid.is_empty() && *guid != "MachineGuid" && *guid != "REG_SZ" {
                return guid.to_string();
            }
        }
    }
    String::new()
}

#[cfg(target_os = "linux")]
fn hardware_id() -> String {
    if let Ok(id) = fs::read_to_string("/etc/machine-id") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(id) = fs::read_to_string("/sys/class/dmi/id/product_uuid") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    String::new()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn hardware_id() -> String {
    String::new()
}

fn collect_fingerprint() -> MachineFingerprint {
    let hw = hardware_id();
    let mac = primary_mac();
    let host = hostname_factor();
    let fingerprint = hash_machine_fingerprint(&hw, &mac, &host);
    MachineFingerprint {
        fingerprint,
        version: FINGERPRINT_VERSION.to_string(),
        created_at: unix_now_secs(),
    }
}

fn unix_now_secs() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn machine_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("device-keys");
    fs::create_dir_all(&dir).map_err(|e| format!("create device-keys dir: {e}"))?;
    Ok(dir.join(MACHINE_FILE))
}

/// Load or create the machine-wide fingerprint. Never fails registration if
/// factors are missing — empty factors still produce a deterministic hash.
pub fn get_or_create_machine_fingerprint(
    app: &tauri::AppHandle,
) -> Result<MachineFingerprint, String> {
    let path = machine_path(app)?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read machine.json: {e}"))?;
        if let Ok(existing) = serde_json::from_str::<MachineFingerprint>(&raw) {
            if existing.fingerprint.len() == 64 {
                return Ok(existing);
            }
        }
    }

    let fp = collect_fingerprint();
    let raw = serde_json::to_string_pretty(&fp).map_err(|e| format!("serialize machine: {e}"))?;
    fs::write(&path, &raw).map_err(|e| format!("write machine.json: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    log::info!(
        "[sso] machine fingerprint version={} len={}",
        fp.version,
        fp.fingerprint.len()
    );
    Ok(fp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_for_fixed_inputs() {
        let a = hash_machine_fingerprint("HW-1", "aa:bb:cc:dd:ee:ff", "host.local");
        let b = hash_machine_fingerprint("HW-1", "aa:bb:cc:dd:ee:ff", "host.local");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_changes_when_factor_changes() {
        let a = hash_machine_fingerprint("HW-1", "aa:bb:cc:dd:ee:ff", "host.local");
        let b = hash_machine_fingerprint("HW-2", "aa:bb:cc:dd:ee:ff", "host.local");
        let c = hash_machine_fingerprint("HW-1", "", "host.local");
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn empty_factors_still_hash() {
        let a = hash_machine_fingerprint("", "", "");
        assert_eq!(a.len(), 64);
        let expected = {
            let digest = Sha256::digest(b"v1|||");
            hex::encode(digest)
        };
        assert_eq!(a, expected);
    }
}
