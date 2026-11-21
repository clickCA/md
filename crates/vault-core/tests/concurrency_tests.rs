//! Per-vault mutation serialization (REL-9): one mutating git operation per
//! vault at a time — but per vault, never global, and never blocking note
//! editing.

use std::fs;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;
use tempfile::TempDir;
use vault_core::git_backend::GitBackend;
use vault_core::sync::{self, vault_mutation_guard};
use vault_core::vault::Vault;

/// Remote + one pushed vault, ready for contended syncs.
fn setup() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote_dir = tmp.path().join("remote.git");
    Vault::create_remote(&remote_dir).expect("create remote");
    let remote = remote_dir.to_string_lossy().to_string();

    let a_dir = tmp.path().join("a");
    let a = Vault::create(&a_dir, Some(&remote)).expect("vault a");
    a.write_note("notes/a.md", "one\n").expect("write");
    sync::sync(&a).expect("initial push");

    let b_dir = tmp.path().join("b");
    Vault::create(&b_dir, Some(&remote)).expect("vault b");
    (tmp, a_dir, b_dir)
}

#[test]
fn concurrent_syncs_of_one_vault_serialize_and_both_succeed() {
    let (_tmp, a_dir, _b) = setup();
    let a_dir_str = a_dir.to_string_lossy().to_string();

    // Two independent Vault handles (own SQLite connections) racing one sync
    // cycle each. Pending edits so there is real work to contend over.
    {
        let v = Vault::open(&a_dir).expect("open");
        v.write_note("notes/a.md", "two\n").expect("pending edit");
    }

    let handles: Vec<_> = (0..2)
        .map(|_| {
            let dir = a_dir_str.clone();
            thread::spawn(move || {
                // Stagger slightly so the races actually overlap.
                thread::sleep(Duration::from_millis(10));
                let v = Vault::open(std::path::Path::new(&dir)).expect("open");
                sync::sync(&v)
            })
        })
        .collect();
    for h in handles {
        let outcome = h.join().expect("thread did not panic").expect("sync ok");
        assert!(
            matches!(outcome.action.as_str(), "push" | "up-to-date"),
            "unexpected action: {}",
            outcome.action
        );
    }

    // Exactly two finished journal runs, and the worktree converged to HEAD.
    let v = Vault::open(&a_dir).expect("reopen");
    let pending = {
        let fs_blobs = vault_core::merge::flatten_blobs(&v.fs_tree().expect("fs_tree"));
        let head_blobs = vault_core::merge::flatten_blobs(&v.git.head_tree().expect("head_tree"));
        fs_blobs != head_blobs
    };
    assert!(!pending, "worktree must be clean after serialized syncs");
    assert_eq!(
        fs::read_to_string(v.root.join("notes/a.md")).expect("note"),
        "two\n",
        "the committed edit survives both cycles"
    );
}

#[test]
fn the_mutation_lock_is_per_vault_never_global() {
    let (_tmp, a_dir, b_dir) = setup();

    // Hold vault A's guard (as an in-flight sync would): vault B's sync must
    // still complete — a global lock would deadlock this.
    let guard = vault_mutation_guard(&Vault::open(&a_dir).expect("open a"));
    let (tx, rx) = channel();
    thread::spawn(move || {
        let b = Vault::open(&b_dir).expect("open b");
        let _ = tx.send(sync::sync(&b));
    });
    let outcome = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("vault B must not wait on vault A's lock");
    assert!(outcome.is_ok(), "vault B sync failed: {outcome:?}");
    drop(guard);
}

#[test]
fn note_editing_is_never_blocked_by_the_mutation_lock() {
    let (_tmp, a_dir, _b) = setup();
    let v = Vault::open(&a_dir).expect("open");

    // An in-flight sync holds the guard: editing still works immediately.
    let guard = vault_mutation_guard(&v);
    v.write_note("notes/a.md", "edited during sync\n")
        .expect("write while sync lock held");
    assert_eq!(
        fs::read_to_string(v.root.join("notes/a.md")).expect("read"),
        "edited during sync\n"
    );
    drop(guard);
}
