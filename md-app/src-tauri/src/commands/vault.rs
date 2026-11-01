//! Vault lifecycle (probe / create / open) and synchronization commands.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use vault_core::git_backend::GitBackend;
use vault_core::vault::Vault;
use vault_core::{SyncOutcome, sync};

use super::blocking;
use super::dto::{ConflictDto, CredDto, StatusDto, conflict_dto, status_dto};
use crate::error::AppError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDto {
    pub exists: bool,
    pub is_vault: bool,
    pub remote_url: Option<String>,
    pub note_count: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDto {
    pub action: String,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub conflicts: Vec<ConflictDto>,
}

fn sync_dto(outcome: SyncOutcome) -> SyncDto {
    SyncDto {
        action: outcome.action,
        head: outcome.head,
        remote: outcome.remote,
        conflicts: outcome
            .conflicts
            .iter()
            .map(|c| conflict_dto(c, String::new()))
            .collect(),
    }
}

#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(app))]
pub fn default_vault_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app data dir: {e}")))?;
    let vault = base.join("vault");
    std::fs::create_dir_all(&vault)?;
    Ok(vault.to_string_lossy().to_string())
}

#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn vault_probe(dir: String) -> ProbeDto {
    blocking(move || {
        let p = PathBuf::from(&dir);
        let is_vault = p.join(".git").exists();
        let mut remote_url = None;
        let mut note_count = None;
        if is_vault && let Ok(v) = Vault::open(&p) {
            remote_url = v.git.remote_url().ok().flatten();
            note_count = v.fs_files().map(|f| f.len() as u64).ok();
        }
        Ok(ProbeDto {
            exists: p.exists(),
            is_vault,
            remote_url,
            note_count,
        })
    })
    .await
    .unwrap_or(ProbeDto {
        exists: false,
        is_vault: false,
        remote_url: None,
        note_count: None,
    })
}

/// Open the folder as a vault, creating one if it is not a vault yet.
/// Existing vaults get their remote updated when `remote_url` is provided.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn vault_make(dir: String, remote_url: Option<String>) -> Result<StatusDto, AppError> {
    blocking(move || {
        let p = PathBuf::from(&dir);
        if p.join(".git").exists() {
            let mut v = Vault::open(&p)?;
            if let Some(url) = remote_url {
                v.git.set_remote(&url)?;
            }
            return status_dto(&v);
        }
        let v = Vault::create(&p, remote_url.as_deref())?;
        status_dto(&v)
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn vault_status(dir: String) -> Result<StatusDto, AppError> {
    blocking(move || status_dto(&super::open_vault(&dir)?)).await
}

/// One idempotent sync cycle: commit pending → fetch → merge → push.
#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(credentials))]
pub async fn vault_sync(dir: String, credentials: Option<CredDto>) -> Result<SyncDto, AppError> {
    blocking(move || {
        let vault = super::open_vault(&dir)?;
        let creds = credentials.as_ref().map(|c| c.creds());
        let outcome = sync::sync_with(&vault, creds.as_ref())?;
        Ok(sync_dto(outcome))
    })
    .await
}
