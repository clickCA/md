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

fn conflicts(v: &Vault) -> Vec<String> {
    v.db.conflicts().expect("conflicts").into_iter().map(|c| c.path).collect()
}

#[test]
fn happy_path_alternating_edits() {
    let e = setup();

    e.a.write_note("todo.md", "first\n").unwrap();
    let out = sync::sync(&e.a).expect("a initial push");
    assert_eq!(out.action, "push (initial)");

    let out = sync::sync(&e.b).expect("b initial pull");
    assert_eq!(out.action, "fast-forward (initial)");
    assert_eq!(note(&e.b, "todo.md"), "first\n");

    e.b.write_note("todo.md", "first\nsecond\n").unwrap();
    sync::sync(&e.b).expect("b push");
    let out = sync::sync(&e.a).expect("a pull");
    assert_eq!(out.action, "fast-forward");
    assert_eq!(note(&e.a, "todo.md"), "first\nsecond\n");

    e.a.write_note("other.md", "hello\n").unwrap();
    sync::sync(&e.a).expect("a push 2");
    sync::sync(&e.b).expect("b pull 2");
    assert_eq!(note(&e.b, "other.md"), "hello\n");

    let out = sync::sync(&e.a).expect("a up to date");
    assert_eq!(out.action, "up-to-date");
}

#[test]
fn concurrent_nonoverlapping_edits_merge_cleanly() {
    let e = setup();

    e.a.write_note("doc.md", "one\ntwo\nthree\nfour\nfive\n").unwrap();
    sync::sync(&e.a).expect("a push");
    sync::sync(&e.b).expect("b pull");

    e.a.write_note("doc.md", "ONE\ntwo\nthree\nfour\nfive\n").unwrap();
    sync::sync(&e.a).expect("a pushes first");

    e.b.write_note("doc.md", "one\ntwo\nthree\nfour\nFIVE\n").unwrap();
    let out = sync::sync(&e.b).expect("b merges");
    assert_eq!(out.action, "merge");
    assert!(out.conflicts.is_empty(), "no conflicts expected: {:?}", out.conflicts);
    assert_eq!(note(&e.b, "doc.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");

    sync::sync(&e.a).expect("a fast-forwards");
    assert_eq!(note(&e.a, "doc.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
}

#[test]
fn concurrent_overlapping_edits_produce_conflict_copy() {
    let e = setup();

    e.a.write_note("doc.md", "alpha\nbeta\n").unwrap();
    sync::sync(&e.a).expect("a push");
    sync::sync(&e.b).expect("b pull");

    e.a.write_note("doc.md", "alpha\nA-WINS?\n").unwrap();
    sync::sync(&e.a).expect("a pushes");

    e.b.write_note("doc.md", "alpha\nB-VERSION\n").unwrap();
    let out = sync::sync(&e.b).expect("b merges");
    assert_eq!(out.action, "merge");
    assert_eq!(out.conflicts.len(), 1);
    assert_eq!(out.conflicts[0].path, "doc.md");

    let copies: Vec<String> = fs::read_dir(&e.b.root)
        .unwrap()
        .filter_map(|d| d.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with("doc.conflict-"))
        .collect();
    assert_eq!(copies.len(), 1, "exactly one conflict copy, got {copies:?}");
    let loser = note(&e.b, &copies[0]);
    assert!(
        loser.contains("A-WINS?") || loser.contains("B-VERSION"),
        "loser version preserved: {loser:?}"
    );
    let winner = note(&e.b, "doc.md");
    assert!(
        winner.contains("A-WINS?") || winner.contains("B-VERSION"),
        "winner present: {winner:?}"
    );

    sync::sync(&e.a).expect("a catches up");
    assert!(fs::read_dir(&e.a.root)
        .unwrap()
        .any(|d| d.ok().map(|e| e.file_name().to_string_lossy().starts_with("doc.conflict-")).unwrap_or(false)));
    assert!(!conflicts(&e.b).is_empty(), "conflict recorded in db");
}

#[test]
fn delete_vs_edit_edit_wins_with_conflict_copy() {
    let e = setup();

    e.a.write_note("gone.md", "precious\n").unwrap();
    sync::sync(&e.a).expect("a push");
    sync::sync(&e.b).expect("b pull");

    e.a.delete_note("gone.md").unwrap();
    sync::sync(&e.a).expect("a pushes deletion");

    e.b.write_note("gone.md", "precious\nedited\n").unwrap();
    let out = sync::sync(&e.b).expect("b merges");
    assert_eq!(out.action, "merge");
    assert_eq!(out.conflicts.len(), 1);

    assert_eq!(note(&e.b, "gone.md"), "precious\nedited\n");
    let copies: Vec<String> = fs::read_dir(&e.b.root)
        .unwrap()
        .filter_map(|d| d.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with("gone.conflict-"))
        .collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(note(&e.b, &copies[0]), "precious\n");
}

#[test]
fn offline_then_online_single_sync_reconciles() {
    let e = setup();

    e.a.write_note("a1.md", "a1\n").unwrap();
    sync::sync(&e.a).expect("a push");
    sync::sync(&e.b).expect("b pull");

    e.a.write_note("a2.md", "a2\n").unwrap();
    e.a.write_note("a3.md", "a3\n").unwrap();
    e.a.write_note("a1.md", "a1-edited\n").unwrap();

    e.b.write_note("b1.md", "b1\n").unwrap();

    sync::sync(&e.a).expect("a goes online");
    let out = sync::sync(&e.b).expect("b goes online");
    assert_eq!(out.action, "merge");
    assert!(out.conflicts.is_empty());
    sync::sync(&e.a).expect("a catches up");

    for (path, want) in [
        ("a1.md", "a1-edited\n"),
        ("a2.md", "a2\n"),
        ("a3.md", "a3\n"),
        ("b1.md", "b1\n"),
    ] {
        assert_eq!(note(&e.b, path), want);
        assert_eq!(note(&e.a, path), want);
    }
}

#[test]
fn nested_paths_and_subdirectories_sync() {
    let e = setup();

    e.a.write_note("journal/2026/okt.md", "# Okt\n").unwrap();
    e.a.write_note("journal/2026/nov.md", "# Nov\n").unwrap();
    sync::sync(&e.a).expect("a push");
    sync::sync(&e.b).expect("b pull");
    assert_eq!(note(&e.b, "journal/2026/okt.md"), "# Okt\n");

    e.b.write_note("journal/2026/okt.md", "# Oktober\n").unwrap();
    sync::sync(&e.b).expect("b push");
    sync::sync(&e.a).expect("a pull");
    assert_eq!(note(&e.a, "journal/2026/okt.md"), "# Oktober\n");
}

#[test]
fn respects_gitignore_when_committing() {
    let e = setup();

    e.a.write_note(".gitignore", "node_modules/\n*.log\n").unwrap();
    e.a.write_note("note.md", "real content\n").unwrap();
    e.a
        .write_note("node_modules/junk.js", "huge dependency\n")
        .unwrap();
    e.a.write_note("debug.log", "noise\n").unwrap();

    sync::sync(&e.a).expect("a push");

    let tracked = e.a.git.head_tree().unwrap();
    let blobs = vault_core::merge::flatten_blobs(&tracked);
    assert!(blobs.contains_key("note.md"));
    assert!(blobs.contains_key(".gitignore"));
    assert!(!blobs.contains_key("node_modules/junk.js"));
    assert!(!blobs.contains_key("debug.log"));

    // note_list must not surface ignored files either
    sync::sync(&e.b).expect("b pull");
    let on_b = std::fs::read_to_string(e.b.root.join("note.md")).unwrap();
    assert_eq!(on_b, "real content\n");
    assert!(!e.b.root.join("node_modules/junk.js").exists());
}

#[test]
fn search_finds_terms_across_notes() {
    let e = setup();

    e.a.write_note("a.md", "the quick brown fox\nsecond line\n").unwrap();
    e.a.write_note("dir/b.md", "brown bears sleep\n").unwrap();
    e.a.write_note("dir/c.md", "nothing relevant\n").unwrap();

    let hits = e.a.search("BROWN", 50).unwrap();
    assert_eq!(hits.len(), 2, "case-insensitive: {hits:?}");

    let hits = e.a.search("quick fox", 50).unwrap();
    assert_eq!(hits.len(), 1, "multi-term AND on one line");
    assert_eq!(hits[0].path, "a.md");
    assert_eq!(hits[0].matches[0].line, 1);

    assert!(e.a.search("zebra", 50).unwrap().is_empty());
    assert!(e.a.search("   ", 50).unwrap().is_empty());
}

#[test]
fn line_merge_unit_cases() {
    use vault_core::merge::try_line_merge;
    let clean = try_line_merge(b"a\nb\nc\n", b"A\nb\nc\n", b"a\nb\nC\n").unwrap();
    assert_eq!(clean, b"A\nb\nC\n");

    let identical = try_line_merge(b"a\nb\n", b"a\nX\n", b"a\nX\n").unwrap();
    assert_eq!(identical, b"a\nX\n");

    let disjoint_inserts =
        try_line_merge(b"a\nc\n", b"a\nb\nc\n", b"a\nc\nd\n").unwrap();
    assert_eq!(disjoint_inserts, b"a\nb\nc\nd\n");

    assert!(try_line_merge(b"a\nb\n", b"X\nb\n", b"Y\nb\n").is_none());
    assert!(try_line_merge(b"a\nb\n", b"a\nX\nb\n", b"a\nY\nb\n").is_none());

    let added_vs_added = try_line_merge(b"", b"new-a\n", b"new-b\n");
    assert!(added_vs_added.is_none());
}
