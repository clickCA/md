use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::process::exit;
use vault_core::git_backend::GitBackend;
use vault_core::sync;
use vault_core::vault::Vault;

fn usage() -> ! {
    eprintln!(
        "usage: vault-cli <command> [args]
commands:
  init-remote <bare-dir>
  init <vault-dir> <remote-url>
  open-sync <vault-dir>
  edit <vault-dir> <note-path> <content>
  append <vault-dir> <note-path> <content>
  rm <vault-dir> <note-path>
  sync <vault-dir>
  status <vault-dir>"
    );
    exit(2);
}

fn vault_path(arg: Option<String>) -> PathBuf {
    PathBuf::from(arg.unwrap_or_else(|| usage()))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or_else(|| usage());
    let rest = &args[1..];
    match cmd {
        "init-remote" => {
            Vault::create_remote(&vault_path(rest.first().cloned()))?;
            println!("remote initialized");
        }
        "init" => {
            let dir = rest.first().cloned().unwrap_or_else(|| usage());
            let url = rest.get(1).cloned().unwrap_or_else(|| usage());
            Vault::create(&PathBuf::from(&dir), Some(&url))?;
            println!("vault initialized at {dir} -> {url}");
        }
        "edit" => {
            let v = Vault::open(&vault_path(rest.first().cloned()))?;
            let note = rest.get(1).cloned().unwrap_or_else(|| usage());
            let content = rest.get(2).cloned().unwrap_or_default();
            v.write_note(&note, &content)?;
            println!("wrote {note}");
        }
        "append" => {
            let v = Vault::open(&vault_path(rest.first().cloned()))?;
            let note = rest.get(1).cloned().unwrap_or_else(|| usage());
            let content = rest.get(2).cloned().unwrap_or_else(|| usage());
            let existing = std::fs::read_to_string(v.root.join(&note)).unwrap_or_default();
            v.write_note(
                &note,
                &format!(
                    "{existing}{}{}",
                    if existing.is_empty() { "" } else { "\n" },
                    content
                ),
            )?;
            println!("appended to {note}");
        }
        "rm" => {
            let v = Vault::open(&vault_path(rest.first().cloned()))?;
            let note = rest.get(1).cloned().unwrap_or_else(|| usage());
            v.delete_note(&note)?;
            println!("deleted {note}");
        }
        "sync" => {
            let v = Vault::open(&vault_path(rest.first().cloned()))?;
            let outcome = sync::sync(&v)?;
            println!("{}", serde_outcome(&outcome));
            for c in &outcome.conflicts {
                println!(
                    "CONFLICT {} -> {} (winner: {})",
                    c.path, c.conflict_copy, c.winner
                );
            }
        }
        "status" => {
            let v = Vault::open(&vault_path(rest.first().cloned()))?;
            let head = v.git.head_oid()?;
            let pending = {
                let fs_blobs = vault_core::merge::flatten_blobs(&v.fs_tree()?);
                let head_blobs = vault_core::merge::flatten_blobs(&v.git.head_tree()?);
                if fs_blobs == head_blobs {
                    "clean"
                } else {
                    "pending changes"
                }
            };
            println!("head: {}", head.as_deref().unwrap_or("(none)"));
            println!("worktree: {pending}");
            if let Some(run) = v.db.last_run()? {
                println!(
                    "last run #{}: {:?} {}",
                    run.id,
                    run.outcome,
                    run.finished_at.as_deref().unwrap_or("(unfinished)")
                );
                for (at, state) in v.db.events_of(run.id)? {
                    println!("  [{at}] {state}");
                }
            }
            for c in v.db.conflicts()? {
                println!("conflict: {} -> {} ({})", c.path, c.conflict_copy, c.winner);
            }
        }
        other => return Err(anyhow!("unknown command: {other}")),
    }
    Ok(())
}

fn serde_outcome(o: &sync::SyncOutcome) -> String {
    format!(
        "{} head={} remote={} conflicts={}",
        o.action,
        o.head.as_deref().unwrap_or("-"),
        o.remote.as_deref().unwrap_or("-"),
        o.conflicts.len()
    )
}
