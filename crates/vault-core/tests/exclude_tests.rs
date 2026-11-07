//! `.quireignore` exclusions: the app view (file tree, search) hides
//! matching notes while git tracking and history stay untouched; selective
//! sync (the default) keeps them out of commits and pulls until the
//! device's full-sync toggle turns on (see selective_sync_tests).
//!
//! The privacy guarantee under test: excluded content never reaches the
//! UI surfaces — and once a file becomes excluded, its tokens are purged
//! from the FTS index on the next query.

use std::fs;
use tempfile::TempDir;
use vault_core::exclude::Exclusions;
use vault_core::git_backend::GitBackend;
use vault_core::sync;
use vault_core::vault::Vault;

struct Env {
    _tmp: TempDir,
    a: Vault,
}

fn setup() -> Env {
    let tmp = tempfile::tempdir().expect("tempdir");
    let remote_dir = tmp.path().join("remote.git");
    Vault::create_remote(&remote_dir).expect("create remote");
    let remote = remote_dir.to_string_lossy().to_string();
    let a = Vault::create(&tmp.path().join("a"), Some(&remote)).expect("vault a");
    Env { _tmp: tmp, a }
}

fn visible(v: &Vault) -> Vec<String> {
    let mut files: Vec<String> = v
        .visible_files()
        .expect("visible_files")
        .into_iter()
        .map(|(rel, _)| rel)
        .collect();
    files.sort();
    files
}

fn hits(v: &Vault, query: &str) -> Vec<String> {
    let mut paths: Vec<String> = v
        .search(query, 200)
        .expect("search")
        .into_iter()
        .map(|hit| hit.path)
        .collect();
    paths.sort();
    paths
}

#[test]
fn listing_hides_excluded_notes() {
    let e = setup();
    e.a.write_note("public.md", "hello\n").unwrap();
    e.a.write_note("private/secret.md", "hush\n").unwrap();
    e.a.write_note("draft-1.md", "wip\n").unwrap();

    let all = visible(&e.a);
    assert!(all.contains(&"public.md".to_string()));
    assert!(all.contains(&"private/secret.md".to_string()));
    assert!(all.contains(&"draft-1.md".to_string()));

    fs::write(e.a.root.join(".quireignore"), "private/\ndraft-?.md\n").unwrap();
    let filtered = visible(&e.a);
    assert_eq!(filtered, vec![".quireignore", "public.md"]);
    assert!(!filtered.iter().any(|p| p.contains("private/")));
    assert!(!filtered.iter().any(|p| p.contains("draft-")));
}

#[test]
fn search_never_returns_excluded_paths() {
    let e = setup();
    e.a.write_note("public.md", "zebra visible\n").unwrap();
    e.a.write_note("private/secret.md", "zebra hidden orangutan\n")
        .unwrap();
    e.a.write_note("scratch/notes.md", "เสือ visible thai\n")
        .unwrap();
    e.a.write_note("scratch/hidden.md", "เสือ hidden thai\n")
        .unwrap();

    // Nothing excluded yet: both zebra notes are searchable.
    assert_eq!(hits(&e.a, "zebra"), vec!["private/secret.md", "public.md"]);

    // Exclusions apply to FTS results…
    fs::write(
        e.a.root.join(".quireignore"),
        "private/\nscratch/hidden.md\n",
    )
    .unwrap();
    assert_eq!(hits(&e.a, "zebra"), vec!["public.md"]);
    // …the excluded note's unique tokens are purged from the index…
    assert!(hits(&e.a, "orangutan").is_empty());
    // …and the non-ASCII scan fallback respects them too.
    assert_eq!(hits(&e.a, "เสือ"), vec!["scratch/notes.md"]);

    // Removing the exclusion restores the old behavior (re-index on drift).
    fs::remove_file(e.a.root.join(".quireignore")).unwrap();
    assert_eq!(hits(&e.a, "orangutan"), vec!["private/secret.md"]);
}

#[test]
fn selective_sync_keeps_excluded_notes_untracked_until_toggled() {
    let e = setup();
    e.a.write_note("public.md", "hello\n").unwrap();
    e.a.write_note("private/secret.md", "hush\n").unwrap();
    fs::write(e.a.root.join(".quireignore"), "private/\n").unwrap();

    sync::sync(&e.a).expect("initial push (selective by default)");

    // The exclusion rules themselves sync, but the excluded note stays
    // local: not staged, not committed, not pushed (issue #16 semantics).
    let remote = e.a.git.remote_url().expect("remote").expect("remote url");
    let b = Vault::create(&e._tmp.path().join("b"), Some(&remote)).expect("vault b");
    sync::sync(&b).expect("b pull");
    let b_files: Vec<String> = b
        .fs_files()
        .expect("b files")
        .into_iter()
        .map(|(rel, _)| rel)
        .collect();
    assert!(b_files.contains(&"public.md".to_string()));
    assert!(b_files.contains(&".quireignore".to_string()));
    assert!(
        !b_files.contains(&"private/secret.md".to_string()),
        "the excluded note never reached the other device"
    );

    // The note is still on disk locally, and toggling full sync pushes it
    // as a normal change — no loss in either direction.
    assert_eq!(
        fs::read_to_string(e.a.root.join("private/secret.md")).unwrap(),
        "hush\n"
    );
    e.a.set_sync_excluded_files(true).expect("toggle full sync");
    sync::sync(&e.a).expect("full sync pushes the excluded note");

    // Selective b ignores the remote churn under the excluded path...
    sync::sync(&b).expect("b selective pull");
    assert!(!b.root.join("private/secret.md").exists());

    // ...until b runs a full sync as well.
    b.set_sync_excluded_files(true).expect("toggle b");
    sync::sync(&b).expect("b full-pulls the excluded note");
    assert_eq!(
        fs::read_to_string(b.root.join("private/secret.md")).expect("excluded note synced"),
        "hush\n"
    );
}

#[test]
fn fs_tree_keeps_excluded_files_for_commits() {
    let e = setup();
    e.a.write_note("private/secret.md", "hush\n").unwrap();
    fs::write(e.a.root.join(".quireignore"), "private/\n").unwrap();

    // The RAW working-tree view (fs_tree) is unfiltered — only the sync
    // view (sync_tree) applies exclusions.
    let tree = e.a.fs_tree().expect("fs_tree");
    assert!(tree.contains_key("private/secret.md"));
    assert!(tree.contains_key(".quireignore"));

    let exclusions = Exclusions::load(&e.a.root);
    assert!(exclusions.is_excluded("private/secret.md"));
}
