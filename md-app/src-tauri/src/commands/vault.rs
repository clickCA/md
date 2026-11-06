//! Vault lifecycle (probe / create / open) and synchronization commands.

use serde::Serialize;
use std::path::{Path, PathBuf};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfoDto {
    pub name: String,
    pub dir: String,
    pub remote_url: Option<String>,
    pub note_count: Option<u64>,
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

// ---------------------------------------------------------------------------
// Mobile vault manager: multi-vault state in app-sandboxed storage.
//
// Desktop keeps the single `default_vault_dir` / folder-picker flow. On mobile
// (Android/iOS) there is no user-visible filesystem: scoped storage forbids raw
// path access and SAF `content://` URIs are unusable by the std::fs engine. So
// mobile vaults live under `<app data>/vaults/<name>` — fully writable, private,
// and backup-friendly — and are created/cloned/listed through these commands.
// ---------------------------------------------------------------------------

fn vault_info(dir: &Path) -> Result<VaultInfoDto, AppError> {
    let v = Vault::open(dir)?;
    remote_url_and_count(&v)
}

fn remote_url_and_count(v: &Vault) -> Result<VaultInfoDto, AppError> {
    Ok(VaultInfoDto {
        name: v
            .root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        dir: v.root.to_string_lossy().to_string(),
        remote_url: v.git.remote_url()?,
        note_count: v.fs_files().map(|f| f.len() as u64).ok(),
    })
}

/// Absolute app-sandboxed container for managed vaults (`<app data>/vaults`).
fn vaults_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app data dir: {e}")))?;
    let home = base.join("vaults");
    std::fs::create_dir_all(&home)?;
    Ok(home)
}

/// Absolute app-sandboxed container for managed vaults (created on demand).
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn vaults_home(app: tauri::AppHandle) -> Result<String, AppError> {
    vaults_home_dir(&app).map(|p| p.to_string_lossy().to_string())
}

/// Every vault under the sandboxed vaults home, sorted by name.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn vault_list(app: tauri::AppHandle) -> Result<Vec<VaultInfoDto>, AppError> {
    blocking(move || {
        let home = vaults_home_dir(&app)?;
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&home)?.flatten() {
            let dir = entry.path();
            if !dir.is_dir() || !dir.join(".git").exists() {
                continue;
            }
            if let Ok(info) = vault_info(&dir) {
                out.push(info);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
}

/// Clone an http(s) git remote into the sandboxed vaults home. `name` is
/// optional — the remote's last two path segments derive a slug (`owner/repo`
/// → `owner-repo`). Runs one clone cycle (create-with-remote + fetch +
/// materialize); auth failures surface as `AppError::Auth` so the UI can
/// prompt for credentials and retry, same as `vault_sync`.
#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(credentials))]
pub async fn vault_clone(
    app: tauri::AppHandle,
    url: String,
    name: Option<String>,
    credentials: Option<CredDto>,
) -> Result<VaultInfoDto, AppError> {
    blocking(move || {
        let url = url.trim().to_string();
        validate_remote_url(&url)?;
        let home = vaults_home_dir(&app)?;
        let slug = name
            .filter(|n| !n.trim().is_empty())
            .map(|n| safe_name(&n))
            .unwrap_or_else(|| slug_from_url(&url));
        let dir = home.join(&slug);

        // Adopt an existing directory as a retry of a partial clone, but refuse
        // to hijack a vault that already points at a different remote.
        if dir.join(".git").exists() {
            let existing = Vault::open(&dir)?;
            // Only adopt an existing dir as a retry of the same clone; refuse to
            // hijack a vault that already points at a different remote.
            match existing.git.remote_url()? {
                Some(cur) if cur != url => {
                    return Err(AppError::InvalidInput(format!(
                        "vault '{slug}' already exists with a different remote ({cur}) — give this clone another name"
                    )));
                }
                _ => {}
            }
            let mut v = existing;
            v.git.set_remote(&url)?;
            let creds = credentials.as_ref().map(CredDto::creds);
            vault_core::sync::clone_with(&v, creds.as_ref())?;
        } else {
            let v = Vault::create(&dir, Some(&url))?;
            let creds = credentials.as_ref().map(CredDto::creds);
            vault_core::sync::clone_with(&v, creds.as_ref())?;
        }
        remote_url_and_count(&Vault::open(&dir)?)
    })
    .await
}

/// Mobile clone is HTTPS-only (no ssh-agent on device): reject scp-style
/// `user@host:path`, `ssh://`, and `git://` URLs up front with a clear message.
fn validate_remote_url(url: &str) -> Result<(), AppError> {
    if url.len() > 2048 {
        return Err(AppError::InvalidInput("git remote URL is too long".into()));
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("ssh://")
        || lower.starts_with("git://")
        || url.starts_with("git@")
        || (url.contains('@') && !lower.starts_with("http"))
    {
        return Err(AppError::InvalidInput(
            "SSH remotes aren't supported here — use an https:// URL".into(),
        ));
    }
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(AppError::InvalidInput(
            "git remote must be an http:// or https:// URL".into(),
        ));
    }
    Ok(())
}

/// Filesystem-safe vault name: unsafe characters become `-`, runs collapse,
/// leading/trailing punctuation is trimmed, `vault` when nothing remains.
fn safe_name(raw: &str) -> String {
    let mut cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev = '\0';
    for c in cleaned.drain(..) {
        if c == '-' && c == prev {
            continue;
        }
        prev = c;
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_matches(|c| c == '-' || c == '_' || c == '.');
    if trimmed.is_empty() {
        "vault".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Derive a vault name from a git URL: the last ≤2 path segments joined with
/// `-` (`owner/repo` → `owner-repo`), trailing `.git` stripped.
fn slug_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let segs: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    let tail: Vec<&str> = segs
        .iter()
        .rev()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let joined = tail.join("-");
    let stem = joined.strip_suffix(".git").unwrap_or(&joined);
    safe_name(stem)
}

#[cfg(test)]
mod tests {
    use super::{safe_name, slug_from_url, validate_remote_url};

    #[test]
    fn safe_name_sanitizes() {
        assert_eq!(safe_name("My Notes"), "My-Notes");
        assert_eq!(safe_name("  a  b  "), "a-b");
        assert_eq!(safe_name("_a.txt_"), "a.txt");
        assert_eq!(safe_name(".."), "vault");
        assert_eq!(safe_name("旅行"), "vault", "non-ASCII falls back");
        // interior dots are legal in filenames; only leading/trailing trim
        assert_eq!(safe_name("a...b"), "a...b");
    }

    #[test]
    fn slug_derived_from_url() {
        assert_eq!(
            slug_from_url("https://github.com/owner/notes.git"),
            "owner-notes"
        );
        assert_eq!(
            slug_from_url("https://gitlab.com/group/sub/project"),
            "sub-project"
        );
        assert_eq!(
            slug_from_url("https://example.com/repo"),
            "example.com-repo"
        );
        assert_eq!(
            slug_from_url("https://github.com/owner/notes.git/"),
            "owner-notes"
        );
    }

    #[test]
    fn remote_url_validation() {
        assert!(validate_remote_url("https://github.com/o/r.git").is_ok());
        assert!(validate_remote_url("http://192.168.1.5/git/r.git").is_ok());
        assert!(validate_remote_url("git@github.com:o/r.git").is_err());
        assert!(validate_remote_url("ssh://git@host:2222/r").is_err());
        assert!(validate_remote_url("git://host/r").is_err());
        assert!(validate_remote_url("o/r.git").is_err());
    }
}
