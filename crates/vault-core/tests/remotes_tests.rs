//! Multiple remotes: add/remove/rename, one primary push target,
//! fetch/merge from a secondary, and per-remote relations. The guarantee
//! under test: a plain sync only ever touches the primary — secondary
//! remotes are consumed only through an explicit sync-from.

use std::path::Path;
use tempfile::TempDir;
use vault_core::git_backend::GitBackend;
use vault_core::sync;
use vault_core::vault::{RemoteState, Vault};

/// All commits reachable from the bare repo's current branch.
fn history_at(repo: &str) -> Vec<String> {
    let g = vault_core::gix_backend::GixBackend::open(Path::new(repo)).expect("open bare repo");
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    let mut stack: Vec<String> = g.head_oid().unwrap().into_iter().collect();
    while let Some(oid) = stack.pop() {
        if !seen.insert(oid.clone()) {
            continue;
        }
        stack.extend(g.read_commit_parents(&oid).unwrap());
        out.push(oid);
    }
    out
}

struct Env {
    _tmp: TempDir,
    a: Vault,
    origin: String,
    mirror: String,
}

fn setup() -> Env {
    let tmp = tempfile::tempdir().expect("tempdir");
    let origin_dir = tmp.path().join("origin.git");
    let mirror_dir = tmp.path().join("mirror.git");
    Vault::create_remote(&origin_dir).expect("origin");
    Vault::create_remote(&mirror_dir).expect("mirror");
    let origin = origin_dir.to_string_lossy().to_string();
    let mirror = mirror_dir.to_string_lossy().to_string();
    let mut a = Vault::create(&tmp.path().join("a"), Some(&origin)).expect("vault a");
    a.add_remote("mirror", &mirror).expect("add mirror");
    Env {
        _tmp: tmp,
        a,
        origin,
        mirror,
    }
}

fn relation_of<'r>(remotes: &'r [RemoteState], name: &str) -> &'r str {
    remotes
        .iter()
        .find(|r| r.name == name)
        .map(|r| r.relation.as_str())
        .unwrap_or("missing")
}

#[test]
fn url_and_name_validation() {
    let mut e = setup();

    for bad_url in [
        "",
        "git@github.com:x/y.git",
        "ssh://github.com/x/y.git",
        "no-scheme",
    ] {
        assert!(
            e.a.add_remote("x", bad_url).is_err(),
            "{bad_url:?} rejected"
        );
    }
    for bad_name in ["", "-x", "with space", "a..b"] {
        assert!(
            e.a.add_remote(bad_name, "https://example.com/x.git")
                .is_err(),
            "{bad_name:?} rejected"
        );
    }
    assert!(
        e.a.add_remote("mirror", "https://example.com/x.git")
            .is_err(),
        "duplicate remote rejected"
    );
    assert!(e.a.remove_remote("nope").is_err(), "unknown remote");
    assert!(e.a.rename_remote("nope", "y").is_err());
}

#[test]
fn plain_sync_touches_only_the_primary() {
    let e = setup();

    e.a.write_note("n.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push to primary");

    // origin received the note; the mirror did not — it is not the target.
    assert_eq!(history_at(&e.origin).len(), 1);
    assert!(
        history_at(&e.mirror).is_empty(),
        "plain sync never touches a secondary remote"
    );
}

#[test]
fn relations_are_reported_per_remote() {
    let mut e = setup();

    e.a.write_note("n.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push to origin");

    let remotes = e.a.remotes().expect("remotes");
    assert_eq!(relation_of(&remotes, "origin"), "in-sync");
    assert_eq!(relation_of(&remotes, "mirror"), "not-published");
    assert!(remotes.iter().find(|r| r.name == "origin").unwrap().primary);
    assert!(!remotes.iter().find(|r| r.name == "mirror").unwrap().primary);

    // Flip the push target to the mirror and push newer work there;
    // origin keeps the old tip, so each remote reports its own state.
    e.a.set_primary_remote("mirror").unwrap();
    e.a.write_note("n.md", "v1\nv2\n").unwrap();
    sync::sync(&e.a).expect("push to mirror");
    let remotes = e.a.remotes().expect("remotes");
    assert_eq!(relation_of(&remotes, "mirror"), "in-sync");
    assert_eq!(relation_of(&remotes, "origin"), "ahead");
    assert_eq!(e.a.git.primary_remote().unwrap(), "mirror");
}

#[test]
fn sync_from_secondary_pulls_without_making_it_the_push_target() {
    let mut e = setup();

    // Publish v1 everywhere: push to origin, then flip primary and sync to
    // the mirror, then flip back.
    e.a.write_note("n.md", "v1\n").unwrap();
    sync::sync(&e.a).expect("push v1 to origin");
    e.a.set_primary_remote("mirror").unwrap();
    sync::sync(&e.a).expect("push v1 to mirror");
    e.a.set_primary_remote("origin").unwrap();

    // A second device works against origin…
    let b = Vault::create(&e._tmp.path().join("b"), Some(&e.origin)).expect("vault b");
    sync::sync(&b).expect("b pulls v1");
    b.write_note("n.md", "v1\nv2 from b\n").unwrap();
    sync::sync(&b).expect("b pushes v2 to origin");

    // …while a works on the mirror.
    e.a.set_primary_remote("mirror").unwrap();
    e.a.write_note("m.md", "mirror work\n").unwrap();
    sync::sync(&e.a).expect("a pushes mirror work to the mirror");

    // a consumes origin (diverged from the mirror's line of work) WITHOUT
    // pushing to origin: fetch+merge from origin, result lands on the
    // primary (mirror).
    let out = sync::sync_with_remote(&e.a, "origin", None).expect("sync from origin");
    assert_eq!(out.action, "merge");
    assert_eq!(note_on(&e.a, "n.md"), "v1\nv2 from b\n");
    assert_eq!(note_on(&e.a, "m.md"), "mirror work\n");

    let merge_tip = out.head.expect("merge head");
    assert!(
        !history_at(&e.origin).contains(&merge_tip),
        "origin did not receive the merge commit (not the push target)"
    );
    assert!(
        history_at(&e.mirror).contains(&merge_tip),
        "the push target received the merge"
    );
}

fn note_on(v: &Vault, path: &str) -> String {
    std::fs::read_to_string(v.root.join(path)).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

#[test]
fn rename_keeps_the_primary_designation_and_remove_falls_back() {
    let mut e = setup();

    e.a.set_primary_remote("mirror").unwrap();
    e.a.rename_remote("mirror", "backup").expect("rename");
    assert_eq!(
        e.a.git.primary_remote().unwrap(),
        "backup",
        "designation follows the rename"
    );

    let names: Vec<String> = e.a.remotes().unwrap().into_iter().map(|r| r.name).collect();
    assert_eq!(names, vec!["backup".to_string(), "origin".to_string()]);

    e.a.remove_remote("backup").expect("remove");
    assert_eq!(
        e.a.git.primary_remote().unwrap(),
        "origin",
        "primary falls back to the first remaining remote"
    );
}
