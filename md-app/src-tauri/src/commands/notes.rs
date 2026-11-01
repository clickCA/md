//! Note CRUD, per-note git status, search, and folder commands.

use serde::Serialize;
use vault_core::git_backend::GitBackend;
use vault_core::merge::flatten_blobs;

use super::blocking;
use super::open_vault;
use crate::error::AppError;

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_list(dir: String) -> Result<Vec<String>, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let mut notes: Vec<String> = vault
            .fs_files()?
            .into_iter()
            .map(|(rel, _)| rel)
            .filter(|rel| rel.ends_with(".md"))
            .collect();
        notes.sort();
        Ok(notes)
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_read(dir: String, path: String) -> Result<String, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        Ok(std::fs::read_to_string(vault.root.join(&path))?)
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(content))]
pub async fn note_write(dir: String, path: String, content: String) -> Result<(), AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        vault.write_note(&path, &content)?;
        Ok(())
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_delete(dir: String, path: String) -> Result<(), AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        vault.delete_note(&path)?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStatusDto {
    pub path: String,
    pub status: String,
}

/// Per-note working-tree status derived from blob oids (no content I/O).
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_statuses(dir: String) -> Result<Vec<NoteStatusDto>, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let fs_blobs = flatten_blobs(&vault.fs_tree()?);
        let head_blobs = flatten_blobs(&vault.git.head_tree()?);
        let mut out: Vec<NoteStatusDto> = fs_blobs
            .into_iter()
            .filter(|(path, _)| path.ends_with(".md"))
            .map(|(path, oid)| {
                let status = match head_blobs.get(&path) {
                    None => "untracked",
                    Some(h) if h == &oid => "clean",
                    Some(_) => "modified",
                };
                NoteStatusDto {
                    path,
                    status: status.to_string(),
                }
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
}

/// Committed content of a note (HEAD), or `None` when it is untracked.
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_base(dir: String, path: String) -> Result<Option<String>, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let head = vault.git.head_tree()?;
        let Some(entry) = head.get(&path) else {
            return Ok(None);
        };
        if entry.is_dir {
            return Ok(None);
        }
        let data = vault.git.read_blob(&entry.oid)?;
        Ok(String::from_utf8(data).ok())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNoteDto {
    pub path: String,
    pub content: String,
    /// `Some(content)` when the working tree matches HEAD (avoids a blob
    /// fetch), `None` when untracked, `Some(head)` when modified.
    pub committed: Option<String>,
}

/// Everything the editor needs in one round trip: path, content, and the
/// committed base for every note. Replaces the per-note `note_read` +
/// `note_base` fan-out after each sync (N+M commands each re-opening the
/// vault → one command, one vault open, one status scan).
#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_snapshot(dir: String) -> Result<Vec<SnapshotNoteDto>, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let fs_blobs = flatten_blobs(&vault.fs_tree()?);
        let head_blobs = flatten_blobs(&vault.git.head_tree()?);
        let mut out: Vec<SnapshotNoteDto> = fs_blobs
            .into_iter()
            .filter(|(path, _)| path.ends_with(".md"))
            .map(|(path, oid)| {
                let content = std::fs::read_to_string(vault.root.join(&path)).unwrap_or_default();
                let committed = match head_blobs.get(&path) {
                    None => None, // untracked
                    Some(h) if h == &oid => Some(content.clone()),
                    Some(h) => vault
                        .git
                        .read_blob(h)
                        .ok()
                        .and_then(|d| String::from_utf8(d).ok()),
                };
                SnapshotNoteDto {
                    path,
                    content,
                    committed,
                }
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn note_move(dir: String, from: String, to: String) -> Result<(), AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let src = vault.root.join(&from);
        let dst = vault.root.join(&to);
        if !src.starts_with(&vault.root) || !dst.starts_with(&vault.root) {
            return Err(AppError::PathEscape(from));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&src, &dst)?;
        if let Some(parent) = src.parent()
            && parent != vault.root
        {
            let _ = std::fs::remove_dir(parent);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn folder_create(dir: String, path: String) -> Result<(), AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let p = vault.root.join(&path);
        if !p.starts_with(&vault.root) {
            return Err(AppError::PathEscape(path));
        }
        std::fs::create_dir_all(p)?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchDto {
    pub line: usize,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub path: String,
    pub matches: Vec<SearchMatchDto>,
}

#[tauri::command]
#[tracing::instrument(level = "debug", err)]
pub async fn search_notes(dir: String, query: String) -> Result<Vec<SearchHitDto>, AppError> {
    blocking(move || {
        let vault = open_vault(&dir)?;
        let hits = vault.search(&query, 200)?;
        Ok(hits
            .into_iter()
            .map(|h| SearchHitDto {
                path: h.path,
                matches: h
                    .matches
                    .into_iter()
                    .map(|m| SearchMatchDto {
                        line: m.line,
                        snippet: m.snippet,
                    })
                    .collect(),
            })
            .collect())
    })
    .await
}
