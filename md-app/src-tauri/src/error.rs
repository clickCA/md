//! Structured application errors crossing the UI ⇄ Rust boundary (FND-13).
//!
//! Every command returns `Result<T, AppError>`; Tauri serializes the error
//! side as `{ "code": "<machine>", "message": "<human>" }`. Codes are part of
//! the UI contract (see `docs/api.md`) — do not rename them casually.

use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    /// Remote refused the operation until credentials are supplied.
    #[error("authentication required")]
    Auth,
    /// vault-core engine failure (git transport, journal, merge, …).
    #[error("{0}")]
    Vault(String),
    /// A requested path is not contained within the vault root.
    #[error("path escapes vault: {0}")]
    PathEscape(String),
    /// Malformed argument coming from the UI layer.
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// Filesystem I/O failure.
    #[error("{0}")]
    Io(String),
    /// Everything else — bugs and unexpected states.
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable code sent to the UI (`code` field).
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Auth => "auth",
            AppError::Vault(_) => "vault",
            AppError::PathEscape(_) => "path-escape",
            AppError::InvalidInput(_) => "invalid-input",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }
}

/// Wire shape the UI relies on: `{ code, message }` (camelCase-agnostic).
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // Backends raise `AuthRequired` deep inside gix/libgit2 wrappers;
        // walk the source chain so the UI gets a typed `auth` code instead of
        // regex-matching free-form text.
        if e.chain().any(|c| {
            c.downcast_ref::<vault_core::git_backend::AuthRequired>()
                .is_some()
        }) {
            return AppError::Auth;
        }
        // libgit2 (push path) reports auth failures as plain text; classify by
        // message so both transports produce the same typed code.
        let msg = e.to_string();
        let lower = msg.to_lowercase();
        if lower.contains("auth") || lower.contains("credential") {
            return AppError::Auth;
        }
        AppError::Vault(msg)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
