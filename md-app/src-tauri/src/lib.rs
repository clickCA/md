//! Application entry: env guards, structured logging init, command registry.
//!
//! The command implementations live in [`commands`] (the UI ⇄ Rust boundary,
//! FND-12); errors are structured [`error::AppError`] payloads (FND-13).

mod commands;
mod error;

use tracing_subscriber::EnvFilter;

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
        .plugin(tauri_plugin_clipboard_manager::init())
        // Auto-update + relaunch (see docs/adr/2026-11-06-auto-update.md):
        // check/install from the JS plugin use the endpoints + pubkey that
        // live in tauri.conf.json (plugins.updater).
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::agent::AgentState::default())
        .setup(|app| {
            // macOS routes Cmd+C/X/V/A into the webview through the responder
            // chain, which only fires when a native Edit menu carries those
            // accelerators — without this menu the shortcuts never reach the
            // page. Windows/Linux bind the Ctrl variants inside the webview
            // itself, so they don't need a menu (and the clipboard context
            // menu in the UI covers mouse users on every platform).
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let edit = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(app).item(&edit).build()?;
                app.set_menu(menu)?;
            }
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::default_vault_dir,
            commands::vault::vault_probe,
            commands::vault::vault_make,
            commands::vault::vault_status,
            commands::vault::vault_sync,
            commands::vault::vault_sync_from,
            commands::vault::vaults_home,
            commands::vault::vault_list,
            commands::vault::vault_clone,
            commands::notes::note_list,
            commands::notes::note_read,
            commands::notes::note_write,
            commands::notes::note_delete,
            commands::notes::note_statuses,
            commands::notes::note_base,
            commands::notes::note_snapshot,
            commands::notes::note_move,
            commands::notes::folder_create,
            commands::notes::search_notes,
            commands::notes::broken_links,
            commands::fsx::save_image,
            commands::fsx::read_file_bytes,
            commands::fsx::vault_path,
            commands::git::git_state_cmd,
            commands::git::git_action,
            commands::git::note_history,
            commands::git::vault_history,
            commands::git::note_revision,
            commands::git::note_restore,
            commands::git::vault_restore,
            commands::git::git_branches,
            commands::git::git_branch_create,
            commands::git::git_branch_switch,
            commands::git::git_remotes,
            commands::git::git_remote_add,
            commands::git::git_remote_remove,
            commands::git::git_remote_rename,
            commands::git::git_remote_set_primary,
            commands::agent::agent_detect,
            commands::agent::agent_run,
            commands::agent::agent_stop,
            commands::ai::ai_text,
            commands::ai::ai_ask,
            commands::ai::ai_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
