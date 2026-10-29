//! Application entry: env guards, structured logging init, command registry.
//!
//! The command implementations live in [`commands`] (the UI ⇄ Rust boundary,
//! FND-12); errors are structured [`error::AppError`] payloads (FND-13).

mod commands;
mod error;

impl CredDto {
    fn creds(&self) -> Credentials {
        Credentials {
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStateDto {
    remote_url: Option<String>,
    head: Option<String>,
    remote: Option<String>,
    relation: String,
}

fn git_state(vault: &Vault) -> Result<GitStateDto, String> {
    let remote_url = vault.git.remote_url().map_err(|e| e.to_string())?;
    let head = vault.git.head_oid().map_err(|e| e.to_string())?;
    let remote = vault.git.remote_main_oid().map_err(|e| e.to_string())?;
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
    Ok(GitStateDto { remote_url, head, remote, relation })
}

#[tauri::command]
fn git_state_cmd(dir: String) -> Result<GitStateDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    git_state(&vault)
}

#[tauri::command]
fn git_action(dir: String, action: String, credentials: Option<CredDto>) -> Result<GitStateDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let creds = credentials.as_ref().map(|c| c.creds());
    let result = match action.as_str() {
        "push" => sync::push_now(&vault, creds.as_ref()),
        "take-remote" => sync::take_remote(&vault, creds.as_ref()),
        "force-publish" => sync::force_publish(&vault, creds.as_ref()),
        other => Err(anyhow::anyhow!("unknown action: {other}")),
    };
    result.map_err(|e| e.to_string())?;
    git_state(&vault)
}

#[tauri::command]
fn default_vault_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let vault = base.join("vault");
    std::fs::create_dir_all(&vault).map_err(|e| e.to_string())?;
    Ok(vault.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictDto {
    path: String,
    conflict_copy: String,
    winner: String,
    at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalDto {
    id: i64,
    started_at: String,
    finished_at: Option<String>,
    outcome: Option<String>,
    events: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusDto {
    root: String,
    head: Option<String>,
    remote_main: Option<String>,
    pending: bool,
    conflicts: Vec<ConflictDto>,
    last_run: Option<JournalDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncDto {
    action: String,
    head: Option<String>,
    remote: Option<String>,
    conflicts: Vec<ConflictDto>,
}

fn conflict_dto(c: &vault_core::sync::ConflictRecord, at: String) -> ConflictDto {
    ConflictDto {
        path: c.path.clone(),
        conflict_copy: c.conflict_copy.clone(),
        winner: c.winner.clone(),
        at,
    }
}

fn status(vault: &Vault) -> Result<StatusDto, String> {
    let head = vault.git.head_oid().map_err(|e| e.to_string())?;
    let remote_main = vault.git.remote_main_oid().map_err(|e| e.to_string())?;
    let fs_blobs = flatten_blobs(&vault.fs_tree().map_err(|e| e.to_string())?);
    let head_blobs = flatten_blobs(&vault.git.head_tree().map_err(|e| e.to_string())?);
    let conflicts = vault
        .db
        .conflicts()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| ConflictDto {
            path: c.path,
            conflict_copy: c.conflict_copy,
            winner: c.winner,
            at: c.at,
        })
        .collect();
    let last_run = vault
        .db
        .last_run()
        .map_err(|e| e.to_string())?
        .map(|run| {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDto {
    exists: bool,
    is_vault: bool,
    remote_url: Option<String>,
    note_count: Option<u64>,
}

#[tauri::command]
fn vault_probe(dir: String) -> ProbeDto {
    let p = PathBuf::from(&dir);
    let is_vault = p.join(".git").exists();
    let mut remote_url = None;
    let mut note_count = None;
    if is_vault {
        if let Ok(v) = Vault::open(&p) {
            remote_url = v.git.remote_url().ok().flatten();
            note_count = v.fs_files().map(|f| f.len() as u64).ok();
        }
    }
    ProbeDto { exists: p.exists(), is_vault, remote_url, note_count }
}

/// Open the folder as a vault, creating one if it is not a vault yet.
/// Existing vaults get their remote updated when `remote_url` is provided.
#[tauri::command]
fn vault_make(dir: String, remote_url: Option<String>) -> Result<StatusDto, String> {
    let p = PathBuf::from(&dir);
    if p.join(".git").exists() {
        let mut v = Vault::open(&p).map_err(|e| e.to_string())?;
        if let Some(url) = remote_url {
            v.git.set_remote(&url).map_err(|e| e.to_string())?;
        }
        return status(&v);
    }
    let v = Vault::create(&p, remote_url.as_deref()).map_err(|e| e.to_string())?;
    status(&v)
}

#[tauri::command]
fn vault_status(dir: String) -> Result<StatusDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    status(&vault)
}

#[tauri::command]
fn note_write(dir: String, path: String, content: String) -> Result<(), String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    vault.write_note(&path, &content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatchDto {
    line: usize,
    snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHitDto {
    path: String,
    matches: Vec<SearchMatchDto>,
}

#[tauri::command]
fn search_notes(dir: String, query: String) -> Result<Vec<SearchHitDto>, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let hits = vault.search(&query, 200).map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|h| SearchHitDto {
            path: h.path,
            matches: h
                .matches
                .into_iter()
                .map(|m| SearchMatchDto { line: m.line, snippet: m.snippet })
                .collect(),
        })
        .collect())
}

#[tauri::command]
fn save_image(dir: String, data: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    if safe_ext.is_empty() {
        return Err("invalid image extension".into());
    }
    let assets = vault.root.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let rel = format!("assets/paste-{millis}.{safe_ext}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    std::fs::write(vault.root.join(&rel), bytes).map_err(|e| e.to_string())?;
    Ok(rel)
}

#[tauri::command]
fn read_file_bytes(dir: String, path: String) -> Result<String, String> {
    use base64::Engine;
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let p = vault.root.join(&path);
    if !p.starts_with(&vault.root) {
        return Err("path escapes vault".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Absolute path of a vault-relative file (for the opener plugin's
/// "reveal in file manager" action). Rejects paths escaping the vault.
#[tauri::command]
fn vault_path(dir: String, path: String) -> Result<String, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let p = vault.root.join(&path);
    if !p.starts_with(&vault.root) {
        return Err("path escapes vault".into());
    }
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn note_list(dir: String) -> Result<Vec<String>, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let mut notes: Vec<String> = vault
        .fs_files()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(rel, _)| rel)
        .filter(|rel| rel.ends_with(".md"))
        .collect();
    notes.sort();
    Ok(notes)
}

#[tauri::command]
fn note_read(dir: String, path: String) -> Result<String, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    std::fs::read_to_string(vault.root.join(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn note_delete(dir: String, path: String) -> Result<(), String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    vault.delete_note(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteStatusDto {
    path: String,
    status: String,
}

/// Per-note working-tree status derived from blob oids (no content I/O).
#[tauri::command]
fn note_statuses(dir: String) -> Result<Vec<NoteStatusDto>, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let fs_blobs = flatten_blobs(&vault.fs_tree().map_err(|e| e.to_string())?);
    let head_blobs = flatten_blobs(&vault.git.head_tree().map_err(|e| e.to_string())?);
    let mut out: Vec<NoteStatusDto> = fs_blobs
        .into_iter()
        .filter(|(path, _)| path.ends_with(".md"))
        .map(|(path, oid)| {
            let status = match head_blobs.get(&path) {
                None => "untracked",
                Some(h) if h == &oid => "clean",
                Some(_) => "modified",
            };
            NoteStatusDto { path, status: status.to_string() }
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Committed content of a note (HEAD), or `null` when it is untracked.
#[tauri::command]
fn note_base(dir: String, path: String) -> Result<Option<String>, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let head = vault.git.head_tree().map_err(|e| e.to_string())?;
    let Some(entry) = head.get(&path) else {
        return Ok(None);
    };
    if entry.is_dir {
        return Ok(None);
    }
    let data = vault.git.read_blob(&entry.oid).map_err(|e| e.to_string())?;
    Ok(String::from_utf8(data).ok())
}

#[tauri::command]
fn note_move(dir: String, from: String, to: String) -> Result<(), String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let src = vault.root.join(&from);
    let dst = vault.root.join(&to);
    if !src.starts_with(&vault.root) || !dst.starts_with(&vault.root) {
        return Err("path escapes vault".into());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    if let Some(parent) = src.parent() {
        if parent != vault.root {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

#[tauri::command]
fn folder_create(dir: String, path: String) -> Result<(), String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let p = vault.root.join(&path);
    if !p.starts_with(&vault.root) {
        return Err("path escapes vault".into());
    }
    std::fs::create_dir_all(p).map_err(|e| e.to_string())
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
fn vault_sync(dir: String, credentials: Option<CredDto>) -> Result<SyncDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let creds = credentials.as_ref().map(|c| c.creds());
    let outcome = sync::sync_with(&vault, creds.as_ref()).map_err(|e| e.to_string())?;
    Ok(sync_dto(outcome))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // never let git credential helpers or askpass prompt on a terminal —
    // auth surfaces in the UI as a typed "authentication required" error
    unsafe {
        std::env::set_var("GIT_TERMINAL_PROMPT", "0");
        std::env::set_var("GIT_ASKPASS", "/bin/true");
        std::env::set_var("SSH_ASKPASS", "/bin/true");
    }

    // structured application logging (FND-13): RUST_LOG wins, else info.
    // Each command runs inside a tracing span; failures log at error level.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_vault_dir,
            vault_probe,
            vault_make,
            vault_status,
            vault_sync,
            note_list,
            note_read,
            note_write,
            note_delete,
            note_statuses,
            note_base,
            note_move,
            folder_create,
            search_notes,
            save_image,
            read_file_bytes,
            vault_path,
            git_state_cmd,
            git_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
