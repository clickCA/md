//! Selective sync: `.quireignore` matches stay out of commits, pushes,
//! merges, and checkouts while the toggle is off — and flow through the
//! normal commit path when it turns on. The guarantee under test: no data
//! loss in either direction, no interference between devices, and git's
//! own semantics untouched.

use std::fs;
use tempfile::TempDir;
use vault_core::git_backend::GitBackend;
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

fn head(v: &Vault) -> String {
    v.git.head_oid().unwrap().expect("head")
}

#[test]
fn excluded_edits_commit_nothing_and_stay_on_disk() {
    let e = setup();

    e.a.write_note("keep.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("initial push");

    e.a.write_note(".quireignore", "scratch/\n").unwrap();
    sync::sync(&e.a).expect("the ignore file itself syncs");
    let before = head(&e.a);

    // Edit inside an excluded folder: no commit entry, no sync action.
    e.a.write_note("scratch/rough.md", "draft work\n").unwrap();
    let out = sync::sync(&e.a).expect("sync with only excluded edits");
    assert_eq!(out.action, "up-to-date", "nothing to commit or pull");
    assert_eq!(head(&e.a), before, "no commit was created");
    assert_eq!(
        note(&e.a, "scratch/rough.md"),
        "draft work\n",
        "file stays on disk"
    );
    assert!(
        e.a.db.conflicts().unwrap().is_empty(),
        "no conflict surfaced for the excluded edit"
    );
}

#[test]
fn remote_churn_under_excluded_paths_never_touches_the_copy() {
    let e = setup();

    // The exclusion list is in place before the path is ever tracked.
    e.a.write_note(".quireignore", "drafts/\n").unwrap();
    sync::sync(&e.a).expect("push the ignore file");
    sync::sync(&e.b).expect("b pulls the ignore file");

    // Device b toggles full sync and churns under the excluded path:
    // an add, then a delete — both committed and pushed.
    e.b.set_sync_excluded_files(true).unwrap();
    e.b.write_note("drafts/added.md", "remote v1\n").unwrap();
    sync::sync(&e.b).expect("b commits + pushes the add");
    e.b.delete_note("drafts/added.md").unwrap();
    sync::sync(&e.b).expect("b commits + pushes the delete");

    // Device a stays selective: it follows the remote history but the
    // excluded churn never touches its working tree — no add, no delete,
    // no conflict copy.
    let out = sync::sync(&e.a).expect("a syncs");
    assert_eq!(out.action, "fast-forward", "a's HEAD follows the remote");
    assert!(out.conflicts.is_empty());
    assert!(
        !e.a.root.join("drafts").exists(),
        "nothing materialized under drafts/"
    );
    assert!(e.a.db.conflicts().unwrap().is_empty());

    // Git's own semantics are untouched: the file exists in history.
    let hist = vault_core::history::note_history(&e.a, "drafts/added.md", 50).unwrap();
    assert_eq!(hist.len(), 2, "added and deleted, both in history");

    // And a later full sync on a brings no surprises (tree already matches).
    e.a.set_sync_excluded_files(true).unwrap();
    let out = sync::sync(&e.a).expect("a full-syncs");
    assert_eq!(out.action, "up-to-date");
    e.a.set_sync_excluded_files(false).unwrap();
}

#[test]
fn toggle_on_commits_the_on_disk_state_without_loss() {
    let e = setup();

    e.a.write_note("notes/a.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push v1");
    e.a.write_note(".quireignore", "scratch/\n").unwrap();
    sync::sync(&e.a).expect("push ignore file");

    // Excluded work accumulates on disk while selective.
    e.a.write_note("scratch/wip.md", "draft v1\n").unwrap();
    sync::sync(&e.a).expect("up-to-date (excluded)");
    assert_eq!(
        e.a.git.remote_branch_oid("main").unwrap(),
        Some(head(&e.a)),
        "the draft never reached the remote"
    );

    // Toggle on: the draft flows through the normal commit path.
    e.a.set_sync_excluded_files(true).unwrap();
    let out = sync::sync(&e.a).expect("full sync commits the draft");
    assert_eq!(out.action, "push", "the accumulated draft is committed");
    assert_eq!(
        e.a.git.remote_branch_oid("main").unwrap(),
        Some(head(&e.a)),
        "draft pushed"
    );

    // A second device pulls and toggles off: the draft arrives, then stays.
    e.b.set_sync_excluded_files(true).unwrap();
    sync::sync(&e.b).expect("b full-pulls the draft");
    assert_eq!(note(&e.b, "scratch/wip.md"), "draft v1\n");
    e.b.write_note("scratch/wip.md", "draft v1\nv2 local edit\n")
        .unwrap();
    e.b.set_sync_excluded_files(false).unwrap();
    sync::sync(&e.b).expect("b selective: edit not committed");
    assert_eq!(note(&e.b, "scratch/wip.md"), "draft v1\nv2 local edit\n");

    // Toggling back on pushes the local edit — still no loss.
    e.b.set_sync_excluded_files(true).unwrap();
    sync::sync(&e.b).expect("b pushes the local edit");
    sync::sync(&e.a).expect("a pulls it");
    assert_eq!(note(&e.a, "scratch/wip.md"), "draft v1\nv2 local edit\n");
}

#[test]
fn two_devices_excluded_edit_interferes_with_nothing() {
    let e = setup();

    e.a.write_note("shared.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push shared");
    sync::sync(&e.b).expect("pull shared");
    e.a.write_note(".quireignore", "private/\n").unwrap();
    sync::sync(&e.a).expect("push ignore");
    sync::sync(&e.b).expect("pull ignore");

    // a edits an excluded path while b does normal work.
    e.a.write_note("private/journal.md", "a's secrets\n")
        .unwrap();
    e.b.write_note("shared.md", "v1\nv2 from b\n").unwrap();
    sync::sync(&e.b).expect("b pushes visible work");
    sync::sync(&e.a).expect("a syncs: pulls b's work, ignores its own excluded edit");
    assert_eq!(
        note(&e.a, "shared.md"),
        "v1\nv2 from b\n",
        "visible work flows"
    );
    assert_eq!(
        note(&e.a, "private/journal.md"),
        "a's secrets\n",
        "excluded edit kept"
    );
    assert!(e.a.db.conflicts().unwrap().is_empty() && e.b.db.conflicts().unwrap().is_empty());

    // b never receives the excluded file.
    assert!(
        !e.b.root.join("private/journal.md").exists(),
        "selective sync keeps excluded content off the other device"
    );
}

#[test]
fn pending_status_reflects_the_sync_view() {
    let e = setup();

    e.a.write_note("keep.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push");
    e.a.write_note(".quireignore", "tmp.md\n").unwrap();
    sync::sync(&e.a).expect("push ignore");

    // An excluded edit does not make the vault look pending…
    e.a.write_note("tmp.md", "ignored\n").unwrap();
    let status = vault_status_like(&e.a);
    assert!(!status, "excluded edits never surface as pending");

    // …and a visible edit does.
    e.a.write_note("keep.md", "v2\n").unwrap();
    assert!(vault_status_like(&e.a), "visible edits are pending");
}

/// The same pending computation the status DTO performs.
fn vault_status_like(v: &Vault) -> bool {
    let fs_blobs = vault_core::merge::flatten_blobs(&v.sync_tree().unwrap());
    let head_blobs =
        vault_core::merge::flatten_blobs(&v.filter_sync_tree(v.git.head_tree().unwrap()).unwrap());
    fs_blobs != head_blobs
}
