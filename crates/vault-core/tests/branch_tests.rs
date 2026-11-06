//! Branch management: create, switch (clean-tree guard), and per-branch
//! sync. The safety guarantee under test: a dirty vault refuses to switch
//! and nothing is ever lost to a branch operation.

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

fn branches(v: &Vault) -> Vec<String> {
    v.git.list_branches().expect("list branches")
}

#[test]
fn switch_swaps_content_and_commits_follow_the_current_branch() {
    let e = setup();

    e.a.write_note("a.md", "on main\n").unwrap();
    sync::sync(&e.a).expect("initial push");

    e.a.create_branch("feature").expect("create branch");
    assert!(branches(&e.a).contains(&"feature".to_string()));
    assert_eq!(e.git_current(), "main", "create must not switch");

    e.a.switch_branch("feature").expect("switch to feature");
    assert_eq!(e.git_current(), "feature");
    assert_eq!(note(&e.a, "a.md"), "on main\n");

    // Commits land on the current branch.
    e.a.write_note("b.md", "feature work\n").unwrap();
    sync::sync(&e.a).expect("commit + push feature");
    let feature_tip = e.a.git.head_oid().unwrap().expect("feature tip");
    assert_eq!(
        e.a.git.branch_oid("feature").unwrap(),
        Some(feature_tip.clone()),
        "the commit moved the current branch, not main"
    );

    // Switching back checks out main's content (b.md disappears).
    e.a.switch_branch("main").expect("switch back to main");
    assert!(!e.a.root.join("b.md").exists());
    assert_eq!(note(&e.a, "a.md"), "on main\n");
    assert_ne!(e.a.git.head_oid().unwrap(), Some(feature_tip));

    // And the feature branch restores it.
    e.a.switch_branch("feature")
        .expect("switch to feature again");
    assert_eq!(note(&e.a, "b.md"), "feature work\n");

    // History follows the current branch.
    let on_feature = vault_core::history::note_history(&e.a, "b.md", 50).unwrap();
    assert_eq!(on_feature.len(), 1, "b.md exists only on feature");
    e.a.switch_branch("main").expect("switch back");
    assert!(
        vault_core::history::note_history(&e.a, "b.md", 50)
            .unwrap()
            .is_empty(),
        "main has no history of the feature-only note"
    );
}

#[test]
fn switch_is_refused_while_dirty_and_changes_nothing() {
    let e = setup();

    e.a.write_note("keep.md", "committed\n").unwrap();
    sync::sync(&e.a).expect("push");
    e.a.create_branch("other").expect("create");

    e.a.write_note("keep.md", "uncommitted edit\n").unwrap();
    let err =
        e.a.switch_branch("other")
            .expect_err("dirty switch refused");
    assert!(
        err.to_string().contains("uncommitted changes"),
        "guidance in the error: {err}"
    );
    assert_eq!(e.git_current(), "main", "HEAD untouched");
    assert_eq!(note(&e.a, "keep.md"), "uncommitted edit\n", "edits kept");

    // Untracked notes block switching the same way.
    e.a.write_note("keep.md", "committed\n").unwrap();
    e.a.write_note("draft.md", "untracked\n").unwrap();
    assert!(e.a.switch_branch("other").is_err(), "untracked = dirty");
    assert_eq!(note(&e.a, "draft.md"), "untracked\n");

    // After the pending change is committed, the switch goes through.
    sync::sync(&e.a).expect("commit + push");
    e.a.switch_branch("other").expect("clean switch works");
}

#[test]
fn switching_to_a_remote_only_branch_materializes_it_locally() {
    let e = setup();

    e.a.write_note("a.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push main");
    e.a.create_branch("notes/idea").expect("create");
    e.a.switch_branch("notes/idea").expect("switch");
    e.a.write_note("idea.md", "branch work\n").unwrap();
    sync::sync(&e.a).expect("push branch");

    // b has never heard of the branch; a sync fetches it, switching brings
    // it into existence locally with the right content.
    sync::sync(&e.b).expect("b fetches all branches");
    assert!(!branches(&e.b).contains(&"notes/idea".to_string()));
    e.b.switch_branch("notes/idea")
        .expect("switch to remote-only branch");
    assert_eq!(note(&e.b, "idea.md"), "branch work\n");
    assert_eq!(e.git_current(), "notes/idea");
    assert_eq!(note(&e.b, "a.md"), "v1\n");
}

#[test]
fn branch_names_are_validated_and_duplicates_rejected() {
    let e = setup();

    e.a.write_note("a.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push");

    for bad in [
        "",
        "-x",
        ".hidden",
        "a..b",
        "with space",
        "x.lock",
        "a/b.lock",
        "x@{y",
    ] {
        assert!(e.a.create_branch(bad).is_err(), "{bad:?} must be rejected");
    }
    e.a.create_branch("feature").expect("first create");
    assert!(e.a.create_branch("feature").is_err(), "duplicate rejected");
    assert!(
        e.a.switch_branch("nope").is_err(),
        "unknown branch rejected"
    );
}

#[test]
fn two_device_branch_round_trip_converges() {
    let e = setup();

    e.a.write_note("shared.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("a push v1");
    sync::sync(&e.b).expect("b pull v1");

    // a works on a branch; b stays on main.
    e.a.create_branch("drafts").expect("create drafts");
    e.a.switch_branch("drafts").expect("switch");
    e.a.write_note("draft.md", "draft v1\n").unwrap();
    sync::sync(&e.a).expect("push drafts");
    assert!(
        e.a.git.remote_branch_oid("drafts").unwrap().is_some(),
        "push published origin/drafts"
    );

    // b's main is untouched by the branch work.
    sync::sync(&e.b).expect("b syncs main");
    assert!(
        !e.b.root.join("draft.md").exists(),
        "main does not gain branch files"
    );

    // b joins the branch, edits, pushes; a pulls and converges.
    e.b.switch_branch("drafts").expect("b joins drafts");
    e.b.write_note("draft.md", "draft v1\nv2 from b\n").unwrap();
    sync::sync(&e.b).expect("b pushes drafts");
    sync::sync(&e.a).expect("a pulls drafts");
    assert_eq!(note(&e.a, "draft.md"), "draft v1\nv2 from b\n");
    assert!(e.a.db.conflicts().unwrap().is_empty() && e.b.db.conflicts().unwrap().is_empty());
}

impl Env {
    fn git_current(&self) -> String {
        self.a.git.current_branch().expect("current branch")
    }
}
