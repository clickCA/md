//! Tauri command surface — the ONLY place the UI crosses into Rust (FND-12).
//!
//! Layout:
//! - [`vault`] — vault lifecycle (probe/create/open) + synchronization
//! - [`notes`] — note CRUD, per-note git status, search, folders
//! - [`git`]   — git state + explicit user-triggered git actions
//! - [`fsx`]   — binary/file access (images, absolute paths)
//! - [`dto`]   — shared wire types (camelCase) + vault status assembly
//!
//! The full contract is documented in `docs/api.md`. Command names,
//! argument names (camelCase) and DTO shapes are UI-visible API: change them
//! in lockstep with `md-app/src/**` or not at all.

pub mod dto;
pub mod fsx;
pub mod git;
pub mod notes;
pub mod vault;

use std::path::PathBuf;
use vault_core::vault::Vault;

use crate::error::AppError;

/// Open a vault, mapping engine failures onto structured [`AppError`]s.
pub(crate) fn open_vault(dir: &str) -> Result<Vault, AppError> {
    Vault::open(&PathBuf::from(dir)).map_err(Into::into)
}

/// Run blocking engine work (git network I/O, FTS rebuilds, worktree scans)
/// on the async runtime's blocking pool.
///
/// Tauri executes non-async commands inline on the main thread — a slow
/// fetch/push there stalls the GTK event loop and freezes the whole window.
/// Every command that touches disk, git, or SQLite is therefore `async` and
/// hops through this helper; the UI stays responsive for the duration.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Internal(format!("background worker: {e}")))?
}
