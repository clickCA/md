//! Tauri command surface — the ONLY place the UI crosses into Rust (FND-12).
//!
//! Layout:
//! - [`vault`] — vault lifecycle (probe/create/open) + synchronization
//! - [`notes`] — note CRUD, per-note git status, search, folders
//! - [`git`]   — git state + explicit user-triggered git actions
//! - [`fsx`]   — binary/file access (images, absolute paths)
//! - [`agent`] — coding-agent CLI integration (opencode/codex/Claude Code)
//! - [`ai`]   — inline AI: single-shot tool-disabled text via the same CLIs
//! - [`dto`]   — shared wire types (camelCase) + vault status assembly
//!
//! The full contract is documented in `docs/api.md`. Command names,
//! argument names (camelCase) and DTO shapes are UI-visible API: change them
//! in lockstep with `md-app/src/**` or not at all.

pub mod agent;
pub mod ai;
pub mod dto;
pub mod fsx;
pub mod git;
pub mod notes;
pub mod vault;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};
use vault_core::vault::Vault;

use crate::error::AppError;

/// Open a vault, mapping engine failures onto structured [`AppError`]s.
pub(crate) fn open_vault(dir: &str) -> Result<Vault, AppError> {
    Vault::open(&PathBuf::from(dir)).map_err(Into::into)
}

/// Spawn a child process, retrying briefly on `ETXTBSY` ("Text file busy").
///
/// On overlayfs (CI containers, some setups' `/tmp`), exec'ing a file that
/// was *just* written can race the underlying copy-up and report ETXTBSY
/// even though the write handle is long closed — observed intermittently in
/// CI for the fake-CLI process tests. A short retry is the standard cure;
/// every other error surfaces unchanged. Giving up after ~2 s keeps a
/// genuinely busy binary from stalling the command.
pub(crate) fn spawn_with_busy_retry(cmd: &mut Command) -> std::io::Result<Child> {
    const DEADLINE: Duration = Duration::from_secs(2);
    const TICK: Duration = Duration::from_millis(20);
    let started = Instant::now();
    loop {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if is_text_file_busy(&e) && started.elapsed() < DEADLINE => {
                thread::sleep(TICK);
            }
            Err(e) => return Err(e),
        }
    }
}

/// `ETXTBSY` is Linux/Unix-only; `std::io::ErrorKind::TextFileBusy` is not
/// stable yet, so compare the raw errno.
fn is_text_file_busy(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(26)
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
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
