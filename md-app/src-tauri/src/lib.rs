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
            commands::fsx::save_image,
            commands::fsx::read_file_bytes,
            commands::fsx::vault_path,
            commands::git::git_state_cmd,
            commands::git::git_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
