//! Git state inspection and explicit user-triggered git actions.
//!
//! Sync is user-triggered by design (no background auto-sync until conflict
//! handling is proven reliable — see the Phase 4 plan and the sync ADR).

use serde::Serialize;
use vault_core::git_backend::GitBackend;
use vault_core::history;
use vault_core::vault::Vault;

use super::dto::CredDto;
use super::open_vault;
use crate::error::AppError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStateDto {
    pub remote_url: Option<String>,
    /// Branch HEAD points at; commits and pushes follow it.
    pub branch: String,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub relation: String,
}

fn git_state(vault: &Vault) -> Result<GitStateDto, AppError> {
    let remote_url = vault.git.remote_url()?;
    let branch = vault.git.current_branch()?;
    let head = vault.git.head_oid()?;
    let remote = vault.git.remote_branch_oid(&branch)?;
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
        branch,
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

// --- History (browse + restore) ---

fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(50).clamp(1, 200) as usize
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    pub oid: String,
    pub message: String,
    pub author: String,
    pub time: i64,
    /// "added" | "modified" | "deleted" at this revision.
    pub change: String,
    /// Path the note had at this revision (differs after a rename).
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDto {
    pub oid: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Serialize)]
pub struct RevisionDto {
    pub content: String,
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_history(
    dir: String,
    path: String,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntryDto>, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        Ok(history::note_history(&vault, &path, clamp_limit(limit))?
            .into_iter()
            .map(|rev| HistoryEntryDto {
                oid: rev.commit.oid,
                message: rev.commit.message,
                author: rev.commit.author,
                time: rev.commit.time,
                change: rev.change.as_str().to_string(),
                path: rev.path,
            })
            .collect())
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn vault_history(dir: String, limit: Option<u32>) -> Result<Vec<CommitDto>, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        Ok(history::vault_history(&vault, clamp_limit(limit))?
            .into_iter()
            .map(|c| CommitDto {
                oid: c.oid,
                message: c.message,
                author: c.author,
                time: c.time,
            })
            .collect())
    })
    .await
}

/// Read-only content of one history entry. A `deleted` entry resolves to
/// the content the commit removed (the note's state just before deletion).
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_revision(
    dir: String,
    path: String,
    oid: String,
    change: String,
) -> Result<RevisionDto, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        let rev = revision_from(&path, &oid, &change)?;
        Ok(RevisionDto {
            content: history::revision_content(&vault, &rev)?,
        })
    })
    .await
}

/// Restore a history entry: writes the revision content back to `path`
/// (the note's current path) through the normal write path, so the restore
/// itself is a normal commit-and-sync change. Never deletes or rewrites.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_restore(
    dir: String,
    path: String,
    oid: String,
    change: String,
) -> Result<(), AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        let rev = revision_from(&path, &oid, &change)?;
        history::restore_revision(&vault, &path, &rev)?;
        Ok(())
    })
    .await
}

/// Vault-level restore: write every note present at `oid` back through the
/// normal write path. Notes created after the revision are left alone.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn vault_restore(dir: String, oid: String) -> Result<(), AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        history::restore_snapshot(&vault, &oid)?;
        Ok(())
    })
    .await
}

fn revision_from(path: &str, oid: &str, change: &str) -> Result<history::NoteRevision, AppError> {
    let change = match change {
        "added" => history::Change::Added,
        "modified" => history::Change::Modified,
        "deleted" => history::Change::Deleted,
        other => {
            return Err(AppError::InvalidInput(format!(
                "unknown change kind: {other}"
            )));
        }
    };
    Ok(history::NoteRevision {
        commit: vault_core::git_backend::CommitMeta {
            oid: oid.to_string(),
            message: String::new(),
            author: String::new(),
            time: 0,
        },
        change,
        path: path.to_string(),
    })
}

// --- Branch management ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchesDto {
    pub current: String,
    pub branches: Vec<String>,
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn git_branches(dir: String) -> Result<BranchesDto, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        Ok(BranchesDto {
            current: vault.git.current_branch()?,
            branches: vault.git.list_branches()?,
        })
    })
    .await
}

/// Create a branch at the current head (like `git branch` — no switch).
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn git_branch_create(dir: String, name: String) -> Result<BranchesDto, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        vault.create_branch(&name)?;
        Ok(BranchesDto {
            current: vault.git.current_branch()?,
            branches: vault.git.list_branches()?,
        })
    })
    .await
}

/// Switch branches. Refused while the working tree is dirty — the user
/// saves and syncs first; nothing is ever lost to a switch.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn git_branch_switch(dir: String, name: String) -> Result<GitStateDto, AppError> {
    super::blocking(move || {
        let vault = open_vault(&dir)?;
        vault.switch_branch(&name)?;
        git_state(&vault)
    })
    .await
}
