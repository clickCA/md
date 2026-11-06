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
  status <vault-dir>
  bench <vault-dir> [notes] [words]
        (generate a synthetic corpus, then time the engine paths the UI
         exercises: list, full read, search cold/warm, one edit→sync cycle)
"
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
        "bench" => {
            let dir = vault_path(rest.first().cloned());
            let notes: usize = rest.get(1).and_then(|s| s.parse().ok()).unwrap_or(2000);
            let words: usize = rest.get(2).and_then(|s| s.parse().ok()).unwrap_or(120);
            bench(&dir, notes, words)?;
        }
        other => return Err(anyhow!("unknown command: {other}")),
    }
    Ok(())
}

/// Large-workspace performance harness — run through `make bench` (release
/// build; in debug builds the numbers are meaningless and it is never part
/// of `make test`). Generates a synthetic corpus, then times the engine
/// paths the UI exercises: listing, full read (the editor snapshot), search
/// against a cold index and a warm one, and a single edit→sync cycle.
fn bench(dir: &std::path::Path, notes: usize, words: usize) -> Result<()> {
    use std::time::Instant;

    let v = Vault::open(dir)?;
    println!("bench vault={} notes={notes} words={words}", dir.display());

    let mut t = Instant::now();
    for i in 0..notes {
        v.write_note(&format!("notes/note-{i:05}.md"), &note_content(i, words))?;
    }
    println!(
        "{:<32} {:>7} ms",
        format!("write {notes} notes"),
        t.elapsed().as_millis()
    );

    t = Instant::now();
    let outcome = sync::sync(&v)?;
    println!(
        "{:<32} {:>7} ms  ({})",
        "initial sync (commit+push)",
        t.elapsed().as_millis(),
        outcome.action
    );

    t = Instant::now();
    let files = v.fs_files()?;
    println!(
        "{:<32} {:>7} ms",
        format!("note_list ({} notes)", files.len()),
        t.elapsed().as_millis()
    );

    t = Instant::now();
    let mut bytes = 0usize;
    for (_, path) in &files {
        bytes += std::fs::read(path)?.len();
    }
    println!(
        "{:<32} {:>7} ms  ({bytes} bytes)",
        format!("note_snapshot ({} notes)", files.len()),
        t.elapsed().as_millis()
    );

    t = Instant::now();
    let hits = v.search("meeting", 200)?;
    println!(
        "{:<32} {:>7} ms  ({} hits)",
        "search cold  \"meeting\"",
        t.elapsed().as_millis(),
        hits.len()
    );

    t = Instant::now();
    let hits = v.search("meeting", 200)?;
    println!(
        "{:<32} {:>7} ms  ({} hits)",
        "search warm  \"meeting\"",
        t.elapsed().as_millis(),
        hits.len()
    );

    let needle = format!("token{}", notes / 2);
    t = Instant::now();
    let hits = v.search(&needle, 200)?;
    println!(
        "{:<32} {:>7} ms  ({} hits)",
        format!("search exact \"{needle}\""),
        t.elapsed().as_millis(),
        hits.len()
    );

    t = Instant::now();
    v.write_note(
        "notes/note-00000.md",
        &format!(
            "{}\nEdited for the sync-cycle benchmark.\n",
            note_content(0, words)
        ),
    )?;
    sync::sync(&v)?;
    println!(
        "{:<32} {:>7} ms",
        "edit + sync cycle",
        t.elapsed().as_millis()
    );

    Ok(())
}

/// Deterministic synthetic note: a topic shared by every 8th note (so the
/// common-term search hits `notes / 8` notes) plus a unique `token{i}` (so
/// the exact search hits exactly one). `words` sizes the body.
fn note_content(i: usize, words: usize) -> String {
    const TOPICS: [&str; 8] = [
        "meeting", "project", "idea", "journal", "research", "reading", "planning", "review",
    ];
    const FILLERS: [&str; 16] = [
        "weekly",
        "sync",
        "agenda",
        "outcome",
        "decision",
        "owner",
        "status",
        "update",
        "draft",
        "deadline",
        "follow-up",
        "summary",
        "action",
        "items",
        "retro",
        "demo",
    ];
    let topic = TOPICS[i % TOPICS.len()];
    let mut content =
        format!("# Bench note {i}\n\nTopic: {topic}. Contains token{i} for exact lookup.\n\n");
    let mut count = 0;
    while count < words {
        for (k, filler) in FILLERS.iter().enumerate() {
            content.push_str(filler);
            content.push(' ');
            if (i + count + k).is_multiple_of(9) {
                content.push_str(topic);
                content.push(' ');
            }
            count += 1;
        }
        content.push('\n');
    }
    content
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
