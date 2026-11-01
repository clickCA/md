//! Git state inspection and explicit user-triggered git actions.
//!
//! Sync is user-triggered by design (no background auto-sync until conflict
//! handling is proven reliable — see the Phase 4 plan and the sync ADR).

use serde::Serialize;
use vault_core::git_backend::GitBackend;
use vault_core::vault::Vault;

use super::dto::CredDto;
use super::open_vault;
use crate::error::AppError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStateDto {
    pub remote_url: Option<String>,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub relation: String,
}

fn git_state(vault: &Vault) -> Result<GitStateDto, AppError> {
    let remote_url = vault.git.remote_url()?;
    let head = vault.git.head_oid()?;
    let remote = vault.git.remote_main_oid()?;
    let relation = if remote_url.is_none() {
        "no-remote".to_string()
    } else if remote.is_none() && head.is_none() {
        "empty".to_string()
    } else if remote.is_none() {
        "not-published".to_string()
    } else if head.is_none() {
        "remote-only".to_string()
    } else if head == remote {
        "in-sync".to_string()
    } else {
        let h = head.clone().unwrap();
        let r = remote.clone().unwrap();
        match vault.git.merge_base(&h, &r) {
            Ok(Some(mb)) if mb == r => "ahead".to_string(),
            Ok(Some(mb)) if mb == h => "behind".to_string(),
            Ok(Some(_)) => "diverged".to_string(),
            Ok(None) => "unrelated".to_string(),
            Err(_) => "unknown".to_string(),
        }
    };
    Ok(GitStateDto {
        remote_url,
        head,
        remote,
        relation,
    })
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn git_state_cmd(dir: String) -> Result<GitStateDto, AppError> {
    super::blocking(move || git_state(&open_vault(&dir)?)).await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(credentials))]
pub async fn git_action(
    dir: String,
    action: String,
    credentials: Option<CredDto>,
) -> Result<GitStateDto, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        let creds = credentials.as_ref().map(|c| c.creds());
        let result = match action.as_str() {
            "push" => vault_core::sync::push_now(&vault, creds.as_ref()),
            "take-remote" => vault_core::sync::take_remote(&vault, creds.as_ref()),
            "force-publish" => vault_core::sync::force_publish(&vault, creds.as_ref()),
            other => Err(anyhow::anyhow!("unknown action: {other}")),
        };
        result?;
        git_state(&vault)
    })
    .await
}
