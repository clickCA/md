//! `.quireignore` exclusions: the app view (file tree, search) hides
//! matching notes while git tracking, sync, and history stay untouched.
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
fn sync_still_commits_and_pushes_excluded_notes() {
    let e = setup();
    e.a.write_note("public.md", "hello\n").unwrap();
    e.a.write_note("private/secret.md", "hush\n").unwrap();
    fs::write(e.a.root.join(".quireignore"), "private/\n").unwrap();

    sync::sync(&e.a).expect("initial push");

    // The remote (via a second clone) received the excluded note AND the
    // exclusion rules themselves — nothing was dropped from git.
    let remote = e.a.git.remote_url().expect("remote").expect("remote url");
    let b = Vault::create(&e._tmp.path().join("b"), Some(&remote)).expect("vault b");
    sync::sync(&b).expect("b pull");
    let b_files = b
        .fs_files()
        .expect("b files")
        .into_iter()
        .map(|(rel, _)| rel);
    for expected in ["public.md", "private/secret.md", ".quireignore"] {
        assert!(
            b_files.clone().any(|p| p == expected),
            "second clone should contain {expected}"
        );
    }
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

    // The commit view (fs_tree) is the unfiltered one: the excluded note is
    // part of the tree that gets committed, unlike the app view.
    let tree = e.a.fs_tree().expect("fs_tree");
    assert!(tree.contains_key("private/secret.md"));
    assert!(tree.contains_key(".quireignore"));

    let exclusions = Exclusions::load(&e.a.root);
    assert!(exclusions.is_excluded("private/secret.md"));
}
