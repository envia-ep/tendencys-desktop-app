//! Native save / print for product label PDFs and shell Settings.
//!
//! Prefs live in `preferences.json` (tauri-plugin-store) written by the shell.
//! Product webviews call `desktop_deliver_file`; Settings calls `list_printers`
//! / `print_test_page` / `save_bytes`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_dialog::DialogExt;

use crate::process_util::output_hidden;

const PREFERENCES_FILE: &str = "preferences.json";
const SERVICE_PREFS_KEY: &str = "servicePrefs";
const SVC_PREFIX: &str = "svc-";

/// Minimal one-page PDF used by Settings → Test print.
const TEST_PRINT_PDF: &[u8] = b"%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 55 >>stream
BT /F1 18 Tf 72 720 Td (Envia.com desktop test print) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000373 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
450
%%EOF
";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelPrintMode {
    Instant,
    System,
    Save,
}

impl Default for LabelPrintMode {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePreferences {
    #[serde(default)]
    pub label_print_mode: LabelPrintMode,
    #[serde(default)]
    pub label_printer: String,
}

impl Default for ServicePreferences {
    fn default() -> Self {
        Self {
            label_print_mode: LabelPrintMode::System,
            label_printer: String::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverFileRequest {
    /// `print` or `save`
    pub intent: String,
    pub file_name: String,
    pub mime: Option<String>,
    pub data_base64: Option<String>,
    pub url: Option<String>,
}

fn preferences_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(dir.join(PREFERENCES_FILE))
}

fn load_service_prefs<R: Runtime>(app: &AppHandle<R>, service_id: &str) -> ServicePreferences {
    let Ok(path) = preferences_path(app) else {
        return ServicePreferences::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return ServicePreferences::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return ServicePreferences::default();
    };
    value
        .get(SERVICE_PREFS_KEY)
        .and_then(|m| m.get(service_id))
        .and_then(|p| serde_json::from_value::<ServicePreferences>(p.clone()).ok())
        .unwrap_or_default()
}

/// Product labels are `svc-<window>--<service_id>` (see webview_manager).
fn service_id_from_label(label: &str) -> Option<&str> {
    let rest = label.strip_prefix(SVC_PREFIX)?;
    rest.split_once("--").map(|(_, service_id)| service_id)
}

async fn decode_bytes(req: &DeliverFileRequest) -> Result<Vec<u8>, String> {
    if let Some(b64) = req.data_base64.as_deref().filter(|s| !s.is_empty()) {
        return STANDARD
            .decode(b64)
            .map_err(|e| format!("invalid base64: {e}"));
    }
    if let Some(url) = req.url.as_deref().filter(|s| !s.is_empty()) {
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("download failed ({})", response.status()));
        }
        return response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("read body: {e}"));
    }
    Err("missing dataBase64 or url".into())
}

fn sanitize_file_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

fn is_zip_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0] == b'P' && bytes[1] == b'K' && bytes[2] == 0x03 && bytes[3] == 0x04
}

fn is_pdf(mime: Option<&str>, file_name: &str, bytes: &[u8]) -> bool {
    if mime.is_some_and(|m| m.eq_ignore_ascii_case("application/pdf")) {
        return true;
    }
    if file_name.to_ascii_lowercase().ends_with(".pdf") {
        return true;
    }
    bytes.starts_with(b"%PDF")
}

fn is_zip(mime: Option<&str>, file_name: &str, bytes: &[u8]) -> bool {
    if mime.is_some_and(|m| {
        m.eq_ignore_ascii_case("application/zip")
            || m.eq_ignore_ascii_case("application/x-zip-compressed")
    }) {
        return true;
    }
    if file_name.to_ascii_lowercase().ends_with(".zip") {
        return true;
    }
    is_zip_bytes(bytes)
}

fn has_useful_extension(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| !ext.is_empty() && ext != "bin")
}

fn with_extension(name: &str, ext: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("label");
    format!("{stem}.{ext}")
}

/// Pick a Downloads-friendly name: honor the caller when possible, but never leave
/// PDF/ZIP bytes as `download.bin` (unopenable on macOS).
pub fn resolve_download_file_name(requested: &str, mime: Option<&str>, bytes: &[u8]) -> String {
    let mut name = sanitize_file_name(requested);
    let generic = name.is_empty()
        || name.eq_ignore_ascii_case("download.bin")
        || name.eq_ignore_ascii_case("download")
        || name.eq_ignore_ascii_case("unknown");

    if is_pdf(mime, &name, bytes) {
        if generic || !has_useful_extension(&name) {
            return with_extension(if generic { "label" } else { &name }, "pdf");
        }
        return name;
    }
    if is_zip(mime, &name, bytes) {
        if generic || !has_useful_extension(&name) {
            return with_extension(if generic { "labels" } else { &name }, "zip");
        }
        return name;
    }
    if generic {
        return "label.pdf".into();
    }
    if !has_useful_extension(&name) {
        name = with_extension(&name, "bin");
    }
    name
}

fn write_temp_file(file_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let safe = sanitize_file_name(file_name);
    let dir = std::env::temp_dir().join("tendencys-desktop");
    fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let path = dir.join(format!("{}-{}", uuid::Uuid::new_v4(), safe));
    let mut f = fs::File::create(&path).map_err(|e| format!("create temp: {e}"))?;
    f.write_all(bytes).map_err(|e| format!("write temp: {e}"))?;
    Ok(path)
}

fn downloads_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Downloads");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(home).join("Downloads");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DOWNLOAD_DIR") {
            return PathBuf::from(xdg);
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Downloads");
        }
    }
    std::env::temp_dir()
}

pub fn unique_download_path(file_name: &str) -> PathBuf {
    let dir = downloads_dir();
    let _ = fs::create_dir_all(&dir);
    let safe = {
        let s = sanitize_file_name(file_name);
        if s.is_empty() {
            "label.pdf".into()
        } else {
            s
        }
    };
    let candidate = dir.join(&safe);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(&safe)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..1000 {
        let p = dir.join(format!("{stem} ({i}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!(
        "{}-{}{}",
        stem,
        uuid::Uuid::new_v4(),
        ext
    ))
}

fn save_to_downloads(file_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = unique_download_path(file_name);
    fs::write(&path, bytes).map_err(|e| format!("write download: {e}"))?;
    Ok(path)
}

/// Parse `name\\tisDefault` lines from the Windows CIM fallback script.
fn parse_printer_tsv(stdout: &str) -> Vec<PrinterInfo> {
    let mut printers = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let is_default = parts.next().unwrap_or("false").trim().eq_ignore_ascii_case("true");
        printers.push(PrinterInfo { name, is_default });
    }
    printers
}

#[cfg(target_os = "windows")]
fn wide_ptr_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // Bound scan so a corrupt buffer cannot hang the Settings UI.
    while len < 4096 && unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
}

#[cfg(target_os = "windows")]
fn default_printer_name_win32() -> String {
    use windows_sys::Win32::Graphics::Printing::GetDefaultPrinterW;

    let mut size: u32 = 0;
    unsafe {
        GetDefaultPrinterW(std::ptr::null_mut(), &mut size);
    }
    if size == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; size as usize];
    let ok = unsafe { GetDefaultPrinterW(buf.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return String::new();
    }
    let len = buf
        .iter()
        .position(|&c| c == 0)
        .unwrap_or((size as usize).saturating_sub(1));
    String::from_utf16_lossy(&buf[..len])
}

/// Prefer Winspool — no console, no PrintManagement module, works on Home/Pro.
#[cfg(target_os = "windows")]
fn list_printers_win32() -> Result<Vec<PrinterInfo>, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;

    let probe = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        )
    };
    if probe != 0 {
        // Unexpected success with a null buffer — treat as empty.
        return Ok(Vec::new());
    }
    let err = unsafe { GetLastError() };
    if err != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("EnumPrintersW size probe failed: {err}"));
    }
    if needed == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; needed as usize];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            buffer.as_mut_ptr(),
            needed,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!("EnumPrintersW failed: {err}"));
    }

    let default_name = default_printer_name_win32();
    let info_size = size_of::<PRINTER_INFO_4W>();
    let mut printers = Vec::with_capacity(returned as usize);
    for i in 0..returned as usize {
        let info = unsafe {
            std::ptr::read_unaligned(
                buffer.as_ptr().add(i * info_size) as *const PRINTER_INFO_4W,
            )
        };
        let name = wide_ptr_to_string(info.pPrinterName);
        if name.is_empty() {
            continue;
        }
        let is_default = !default_name.is_empty() && default_name == name;
        printers.push(PrinterInfo { name, is_default });
    }
    Ok(printers)
}

/// Fallback when Winspool is unavailable. Uses CIM only — never `Get-Printer`
/// (PrintManagement module is missing on many machines).
#[cfg(target_os = "windows")]
fn list_printers_cim_fallback() -> Result<Vec<PrinterInfo>, String> {
    let script = "Get-CimInstance Win32_Printer | ForEach-Object { Write-Output ($_.Name + \"`t\" + ($(if ($_.Default) {'true'} else {'false'}))) }";
    let output = output_hidden({
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd
    })
    .map_err(|e| format!("powershell failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Win32_Printer query failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(parse_printer_tsv(&String::from_utf8_lossy(&output.stdout)))
}

fn list_printers_os() -> Result<Vec<PrinterInfo>, String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let default_name = output_hidden({
            let mut cmd = Command::new("lpstat");
            cmd.arg("-d");
            cmd
        })
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.split(':')
                .nth(1)
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
        });

        let output = output_hidden({
            let mut cmd = Command::new("lpstat");
            cmd.arg("-a");
            cmd
        })
        .map_err(|e| format!("lpstat failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "lpstat: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let mut printers = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let name = line.split_whitespace().next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let is_default = default_name.as_ref().is_some_and(|d| d == &name);
            printers.push(PrinterInfo { name, is_default });
        }
        return Ok(printers);
    }

    #[cfg(target_os = "windows")]
    {
        match list_printers_win32() {
            Ok(list) if !list.is_empty() => return Ok(list),
            Ok(_) => {
                // Empty can be legitimate; still try CIM in case Winspool
                // filtered oddly on this host.
                if let Ok(fallback) = list_printers_cim_fallback() {
                    if !fallback.is_empty() {
                        return Ok(fallback);
                    }
                }
                return Ok(Vec::new());
            }
            Err(win32_err) => {
                log::warn!("[desktop-files] Winspool list failed: {win32_err}; trying CIM");
                return list_printers_cim_fallback()
                    .map_err(|cim_err| format!("{win32_err}; CIM fallback: {cim_err}"));
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("listing printers is not supported on this platform".into())
    }
}

fn print_pdf_silent(path: &Path, printer: Option<&str>) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let mut cmd = Command::new("lp");
        if let Some(name) = printer.filter(|p| !p.is_empty()) {
            cmd.arg("-d").arg(name);
        }
        cmd.arg(path);
        let output = output_hidden(cmd).map_err(|e| format!("lp failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "lp failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy().replace('\'', "''");
        let script = if let Some(name) = printer.filter(|p| !p.is_empty()) {
            let printer = name.replace('\'', "''");
            format!(
                "$ErrorActionPreference = 'Stop'; Start-Process -FilePath '{path_str}' -Verb PrintTo -ArgumentList '{printer}' -WindowStyle Hidden",
                path_str = path_str,
                printer = printer
            )
        } else {
            format!(
                "$ErrorActionPreference = 'Stop'; Start-Process -FilePath '{path_str}' -Verb Print -WindowStyle Hidden",
                path_str = path_str
            )
        };
        let output = output_hidden({
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            cmd
        })
        .map_err(|e| format!("powershell print failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "print failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (path, printer);
        Err("printing is not supported on this platform".into())
    }
}

fn open_with_system(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = output_hidden({
            let mut cmd = Command::new("open");
            cmd.arg(path);
            cmd
        })
        .map_err(|e| format!("open failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "open failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let output = output_hidden({
            let mut cmd = Command::new("xdg-open");
            cmd.arg(path);
            cmd
        })
        .map_err(|e| format!("xdg-open failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "xdg-open failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let output = output_hidden({
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", &path.to_string_lossy()]);
            cmd
        })
        .map_err(|e| format!("start failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "start failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err("open is not supported on this platform".into())
    }
}

fn print_or_open_pdf(path: &Path, mode: LabelPrintMode, printer: &str) -> Result<(), String> {
    match mode {
        LabelPrintMode::Instant => {
            print_pdf_silent(path, Some(printer).filter(|p| !p.is_empty()))
        }
        LabelPrintMode::System => open_with_system(path),
        LabelPrintMode::Save => Err("save mode should not print".into()),
    }
}

/// If Instant/System print is configured, print a just-downloaded PDF label.
pub(crate) fn maybe_print_downloaded_label<R: Runtime>(
    app: &AppHandle<R>,
    service_id: &str,
    path: &Path,
) -> Result<(), String> {
    let prefs = load_service_prefs(app, service_id);
    let is_pdf = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf || prefs.label_print_mode == LabelPrintMode::Save {
        return Ok(());
    }
    print_or_open_pdf(path, prefs.label_print_mode, &prefs.label_printer)
}

#[tauri::command]
pub async fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    // PowerShell / lpstat can take hundreds of ms — keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(list_printers_os)
        .await
        .map_err(|e| format!("list_printers task failed: {e}"))?
}

#[tauri::command]
pub async fn save_bytes(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("invalid base64: {e}"))?;
    let safe = sanitize_file_name(&file_name);

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&safe)
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let path = rx
        .recv()
        .map_err(|_| "save dialog closed".to_string())?
        .ok_or_else(|| "save cancelled".to_string())?;

    let path_buf = path.into_path().map_err(|e| format!("{e}"))?;
    fs::write(&path_buf, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(path_buf.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn print_test_page(app: AppHandle, service_id: String) -> Result<(), String> {
    let prefs = load_service_prefs(&app, &service_id);
    let path = write_temp_file("tendencys-test-print.pdf", TEST_PRINT_PDF)?;
    match prefs.label_print_mode {
        LabelPrintMode::Save => {
            let saved = save_to_downloads("tendencys-test-print.pdf", TEST_PRINT_PDF)?;
            log::info!("[desktop-files] test page saved to {}", saved.display());
            Ok(())
        }
        LabelPrintMode::System => open_with_system(&path),
        LabelPrintMode::Instant => print_pdf_silent(
            &path,
            Some(prefs.label_printer.as_str()).filter(|p| !p.is_empty()),
        ),
    }
}

#[tauri::command]
pub async fn desktop_deliver_file<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: DeliverFileRequest,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let service_id = service_id_from_label(&label)
        .ok_or_else(|| format!("desktop_deliver_file only from product webviews, got {label}"))?
        .to_string();

    let bytes = decode_bytes(&request).await?;
    let mime = request.mime.as_deref();
    let file_name = resolve_download_file_name(&request.file_name, mime, &bytes);
    let prefs = load_service_prefs(&app, &service_id);
    let intent = request.intent.to_ascii_lowercase();
    let pdf = is_pdf(mime, &file_name, &bytes);

    if intent == "save" || prefs.label_print_mode == LabelPrintMode::Save || !pdf {
        let path = save_to_downloads(&file_name, &bytes)?;
        log::info!(
            "[desktop-files] saved {} for {service_id} → {}",
            file_name,
            path.display()
        );
        return Ok(());
    }

    if intent == "print" {
        let path = write_temp_file(&file_name, &bytes)?;
        return print_or_open_pdf(&path, prefs.label_print_mode, &prefs.label_printer);
    }

    Err(format!("unknown intent: {}", request.intent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_printer_tsv_reads_name_and_default() {
        let list = parse_printer_tsv(
            "HP LaserJet\ttrue\n\
             Microsoft Print to PDF\tfalse\n\
             \n\
             Brother\tTRUE\n",
        );
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "HP LaserJet");
        assert!(list[0].is_default);
        assert_eq!(list[1].name, "Microsoft Print to PDF");
        assert!(!list[1].is_default);
        assert_eq!(list[2].name, "Brother");
        assert!(list[2].is_default);
    }
}
