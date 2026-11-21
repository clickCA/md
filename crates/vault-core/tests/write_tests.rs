//! Note-write durability (REL-2 in docs/PRODUCT_REQUIREMENTS.md): a save is
//! atomic — interrupted writes leave the previous complete content, never a
//! partial file — and leave no temp strays behind.

use std::fs;
use std::process::Command;
use tempfile::TempDir;
use vault_core::vault::{atomic_write, Vault};

fn init_vault() -> (TempDir, Vault) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let v = Vault::create(&tmp.path().join("v"), None).expect("create vault");
    (tmp, v)
}

fn note(v: &Vault, path: &str) -> String {
    fs::read_to_string(v.root.join(path)).expect("read note")
}

fn stray_tmps(v: &Vault, dir: &str) -> Vec<String> {
    fs::read_dir(v.root.join(dir))
        .expect("read dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.') && n.ends_with(".tmp"))
        .collect()
}

#[test]
fn write_replaces_content_and_leaves_no_strays() {
    let (_tmp, v) = init_vault();

    v.write_note("notes/a.md", "first\n").expect("write 1");
    assert_eq!(note(&v, "notes/a.md"), "first\n");

    v.write_note("notes/a.md", "second\n").expect("write 2");
    assert_eq!(note(&v, "notes/a.md"), "second\n");

    assert!(
        stray_tmps(&v, "notes").is_empty(),
        "successful writes must sweep temp strays"
    );
    // The temp file is a dotfile that is never `.md`, so the note list and
    // the commit tree cannot mistake a stranded one for a note.
    let listed = v.fs_files().expect("fs_files");
    assert!(listed.iter().all(|(_, p)| p.ends_with("a.md")));
}

#[test]
fn write_survives_a_crash_mid_write_and_self_heals() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("v");
    let dir_str = dir.to_string_lossy().to_string();
    let v = Vault::create(&dir, None).expect("create vault");
    v.write_note("notes/a.md", "old complete content\n")
        .expect("seed write");

    // Abort the subprocess exactly between the fsynced temp write and the
    // rename — the moment a naive fs::write would have already clobbered
    // the note.
    let out = Command::new(env!("CARGO_BIN_EXE_vault-cli"))
        .args(["edit", &dir_str, "notes/a.md", "new content\n"])
        .env("VAULT_SPIKE_ABORT_STATE", "writing")
        .output()
        .expect("spawn vault-cli");
    assert!(
        !out.status.success(),
        "the abort hook must fire the process"
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("VAULT_SPIKE_ABORT_STATE=writing"),
        "abort must come from the write hook, not an earlier failure"
    );

    // Old complete content survives byte-identical — never partial, never empty.
    assert_eq!(note(&v, "notes/a.md"), "old complete content\n");
    let tmps = stray_tmps(&v, "notes");
    assert_eq!(tmps.len(), 1, "the aborted write strands exactly one temp");

    // The next write converges: new content lands and the stray is swept.
    v.write_note("notes/a.md", "new content\n")
        .expect("write after crash");
    assert_eq!(note(&v, "notes/a.md"), "new content\n");
    assert!(stray_tmps(&v, "notes").is_empty(), "stray swept");
}

#[test]
fn atomic_write_to_a_bad_target_fails_without_touching_the_original() {
    let (_tmp, v) = init_vault();
    v.write_note("a.md", "keep\n").expect("seed");

    // A path whose parent is a *file* cannot host a temp sibling: the staged
    // write must fail cleanly and leave the existing note untouched.
    let bogus = v.root.join("a.md").join("nested.md");
    assert!(atomic_write(&bogus, b"x").is_err());
    assert_eq!(note(&v, "a.md"), "keep\n");
}
