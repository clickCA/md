//! Shared wire DTOs (camelCase) crossing the UI ⇄ Rust boundary.
//!
//! These shapes are part of the UI contract (`docs/api.md`); they mirror the
//! TypeScript types in `md-app/src/types.ts`. Field renames are breaking
//! changes — keep both sides in sync.

use serde::{Deserialize, Serialize};
use vault_core::git_backend::GitBackend;
use vault_core::vault::Vault;

use crate::error::AppError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredDto {
    pub username: String,
    pub password: String,
}

impl CredDto {
    pub fn creds(&self) -> vault_core::git_backend::Credentials {
        vault_core::git_backend::Credentials {
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub path: String,
    pub conflict_copy: String,
    pub winner: String,
    pub at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDto {
    pub id: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: Option<String>,
    pub events: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub root: String,
    pub head: Option<String>,
    pub remote_main: Option<String>,
    pub pending: bool,
    pub conflicts: Vec<ConflictDto>,
    pub last_run: Option<JournalDto>,
}

pub fn conflict_dto(c: &vault_core::sync::ConflictRecord, at: String) -> ConflictDto {
    ConflictDto {
        path: c.path.clone(),
        conflict_copy: c.conflict_copy.clone(),
        winner: c.winner.clone(),
        at,
    }
}

/// Assemble full vault status: head vs filesystem, conflicts, last journal run.
pub fn status_dto(vault: &Vault) -> Result<StatusDto, AppError> {
    let head = vault.git.head_oid()?;
    let remote_main = vault.git.remote_main_oid()?;
    let fs_blobs = vault_core::merge::flatten_blobs(&vault.fs_tree()?);
    let head_blobs = vault_core::merge::flatten_blobs(&vault.git.head_tree()?);
    let conflicts = vault
        .db
        .conflicts()?
        .into_iter()
        .map(|c| ConflictDto {
            path: c.path,
            conflict_copy: c.conflict_copy,
            winner: c.winner,
            at: c.at,
        })
        .collect();
    let last_run = vault.db.last_run()?.map(|run| {
        let events = vault.db.events_of(run.id).unwrap_or_default();
        JournalDto {
            id: run.id,
            started_at: run.started_at,
            finished_at: run.finished_at,
            outcome: run.outcome,
            events,
        }
    });
    Ok(StatusDto {
        root: vault.root.display().to_string(),
        head,
        remote_main,
        pending: fs_blobs != head_blobs,
        conflicts,
        last_run,
    })
}
