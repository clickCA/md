//! History browse and restore over the real git log.
//!
//! The restore guarantee under test: a restore is a normal forward change —
//! it resurrects deleted notes, follows renames to their pre-rename path,
//! and converges across a two-device sync without conflicts or loss.

use std::fs;
use tempfile::TempDir;
use vault_core::git_backend::GitBackend;
use vault_core::history::{self, Change};
use vault_core::sync;
use vault_core::vault::Vault;

struct Env {
    _tmp: TempDir,
    a: Vault,
    b: Vault,
}

fn setup() -> Env {
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote_dir = tmp.path().join("remote.git");
    Vault::create_remote(&remote_dir).expect("create remote");
    let remote = remote_dir.to_string_lossy().to_string();
    let a = Vault::create(&tmp.path().join("a"), Some(&remote)).expect("vault a");
    let b = Vault::create(&tmp.path().join("b"), Some(&remote)).expect("vault b");
    Env { _tmp: tmp, a, b }
}

fn note(v: &Vault, path: &str) -> String {
    fs::read_to_string(v.root.join(path))
        .unwrap_or_else(|e| panic!("read note {path} in {}: {e}", v.root.display()))
}

#[test]
fn history_is_path_aware_and_revisions_are_readable() {
    let e = setup();

    e.a.write_note("todo.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("initial push");
    e.a.write_note("todo.md", "v2\n").unwrap();
    sync::sync(&e.a).expect("second push");
    e.a.write_note("other.md", "unrelated\n").unwrap();
    sync::sync(&e.a).expect("third push");

    let note_hist = history::note_history(&e.a, "todo.md", 50).expect("note history");
    assert_eq!(note_hist.len(), 2, "only the commits touching todo.md");
    assert_eq!(note_hist[0].change, Change::Modified);
    assert_eq!(note_hist[1].change, Change::Added);

    // The vault-wide log sees every commit, newest first.
    let vault_hist = history::vault_history(&e.a, 50).expect("vault history");
    assert_eq!(vault_hist.len(), 3);
    assert!(vault_hist[0].time >= vault_hist[1].time);
    assert!(vault_hist.iter().all(|c| c.message.contains("auto:")));

    // Any revision's content is readable read-only.
    let oldest = &note_hist[1].commit.oid;
    assert_eq!(
        history::content_at(&e.a, "todo.md", oldest)
            .unwrap()
            .as_deref(),
        Some("v1\n")
    );
}

#[test]
fn restore_deleted_note_and_two_device_round_trip() {
    let e = setup();

    e.a.write_note("keep.md", "precious v1\n").unwrap();
    sync::sync(&e.a).expect("a push v1");
    sync::sync(&e.b).expect("b pull v1");

    e.a.delete_note("keep.md").unwrap();
    sync::sync(&e.a).expect("a push deletion");
    sync::sync(&e.b).expect("b pull deletion");
    assert!(!e.b.root.join("keep.md").exists(), "deleted on b");

    // b restores the deleted revision — content resolved from the parent.
    let hist = history::note_history(&e.b, "keep.md", 50).expect("history on b");
    assert_eq!(hist[0].change, Change::Deleted, "newest entry is the loss");
    history::restore_revision(&e.b, "keep.md", &hist[0]).expect("restore");
    assert_eq!(note(&e.b, "keep.md"), "precious v1\n");

    // The restore is a normal forward change: sync converges both sides.
    sync::sync(&e.b).expect("b push restore");
    sync::sync(&e.a).expect("a pull restore");
    assert_eq!(note(&e.a, "keep.md"), "precious v1\n");
    assert!(
        e.a.db.conflicts().unwrap().is_empty() && e.b.db.conflicts().unwrap().is_empty(),
        "a restore must never surface as a conflict"
    );

    // And history records the resurrection.
    let after = history::note_history(&e.a, "keep.md", 50).expect("history after restore");
    assert_eq!(after[0].change, Change::Added, "re-created by the restore");
}

#[test]
fn history_follows_renames_and_restore_writes_the_current_path() {
    let e = setup();

    e.a.write_note("old.md", "same content\n").unwrap();
    sync::sync(&e.a).expect("push as old.md");
    // Rename: delete + identical add in one commit.
    e.a.delete_note("old.md").unwrap();
    e.a.write_note("new.md", "same content\n").unwrap();
    sync::sync(&e.a).expect("push rename");

    let hist = history::note_history(&e.a, "new.md", 50).expect("followed history");
    assert_eq!(hist.len(), 2, "rename commit + pre-rename history");
    assert_eq!(hist[0].change, Change::Added);
    assert_eq!(hist[0].path, "new.md");
    assert_eq!(
        hist[1].path, "old.md",
        "pre-rename entry carries the old path"
    );
    assert_eq!(hist[1].change, Change::Added);

    // Restoring the pre-rename revision writes to the *current* path.
    history::restore_revision(&e.a, "new.md", &hist[1]).expect("restore across rename");
    assert_eq!(note(&e.a, "new.md"), "same content\n");
    assert!(!e.a.root.join("old.md").exists());
}

#[test]
fn vault_snapshot_restore_is_forward_only() {
    let e = setup();

    e.a.write_note("one.md", "one v1\n").unwrap();
    e.a.write_note("two.md", "two v1\n").unwrap();
    sync::sync(&e.a).expect("push v1 pair");
    let snapshot_oid = e.a.git.head_oid().unwrap().expect("head");

    e.a.write_note("one.md", "one v2\n").unwrap();
    e.a.write_note("two.md", "two v2\n").unwrap();
    e.a.write_note("three.md", "born later\n").unwrap();
    sync::sync(&e.a).expect("push v2 pair + new note");

    let restored = history::restore_snapshot(&e.a, &snapshot_oid).expect("snapshot restore");
    assert_eq!(restored, 2, "only the notes present at the revision");
    assert_eq!(note(&e.a, "one.md"), "one v1\n");
    assert_eq!(note(&e.a, "two.md"), "two v1\n");
    assert_eq!(
        note(&e.a, "three.md"),
        "born later\n",
        "later notes survive"
    );
}

#[test]
fn empty_history_for_missing_notes_and_empty_vaults() {
    let e = setup();

    assert!(
        history::note_history(&e.a, "nope.md", 50)
            .unwrap()
            .is_empty(),
        "no commits, no history"
    );
    assert!(history::vault_history(&e.a, 50).unwrap().is_empty());

    e.a.write_note("x.md", "x\n").unwrap();
    sync::sync(&e.a).expect("push");
    assert!(history::note_history(&e.a, "nope.md", 50)
        .unwrap()
        .is_empty());
    assert_eq!(
        history::content_at(&e.a, "nope.md", &e.a.git.head_oid().unwrap().unwrap()).unwrap(),
        None
    );
}
