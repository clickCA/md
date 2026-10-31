//! Binary and absolute-path access: saved images, file bytes, vault paths.

use base64::Engine;

use super::open_vault;
use crate::error::AppError;

/// Store pasted/dropped image bytes under `assets/`, return the vault-relative
/// path to embed in Markdown.
#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(data))]
pub fn save_image(dir: String, data: String, ext: String) -> Result<String, AppError> {
    let vault = open_vault(&dir)?;
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    if safe_ext.is_empty() {
        return Err(AppError::InvalidInput("invalid image extension".into()));
    }
    let assets = vault.root.join("assets");
    std::fs::create_dir_all(&assets)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let rel = format!("assets/paste-{millis}.{safe_ext}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AppError::InvalidInput(format!("base64 payload: {e}")))?;
    std::fs::write(vault.root.join(&rel), bytes)?;
    Ok(rel)
}

/// Base64 bytes of a vault-relative file (images render as data URLs).
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub fn read_file_bytes(dir: String, path: String) -> Result<String, AppError> {
    let vault = open_vault(&dir)?;
    let p = vault.root.join(&path);
    if !p.starts_with(&vault.root) {
        return Err(AppError::PathEscape(path));
    }
    let bytes = std::fs::read(&p)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Absolute path of a vault-relative file (for the opener plugin's
/// "reveal in file manager" action). Rejects paths escaping the vault.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub fn vault_path(dir: String, path: String) -> Result<String, AppError> {
    let vault = open_vault(&dir)?;
    let p = vault.root.join(&path);
    if !p.starts_with(&vault.root) {
        return Err(AppError::PathEscape(path));
    }
    Ok(p.to_string_lossy().to_string())
}
