use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use vault_core::git_backend::GitBackend;
use vault_core::merge::flatten_blobs;
use vault_core::vault::Vault;
use vault_core::{sync, SyncOutcome};

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

#[tauri::command]
fn vault_open(dir: String) -> Result<StatusDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    status(&vault)
}

#[tauri::command]
fn vault_init(dir: String, remote_url: String) -> Result<StatusDto, String> {
    let vault = Vault::create(&PathBuf::from(&dir), Some(&remote_url)).map_err(|e| e.to_string())?;
    status(&vault)
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
fn vault_sync(dir: String) -> Result<SyncDto, String> {
    let vault = Vault::open(&PathBuf::from(&dir)).map_err(|e| e.to_string())?;
    let outcome = sync::sync(&vault).map_err(|e| e.to_string())?;
    Ok(sync_dto(outcome))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            default_vault_dir,
            vault_open,
            vault_init,
            vault_status,
            vault_sync,
            note_list,
            note_read,
            note_write,
            note_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
