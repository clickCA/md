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
