//! Search-index correctness (CORE): the FTS5 index is a rebuildable
//! optimization — every test here tries to make the index lie and asserts
//! that search() still tells the truth.

use std::fs;
use tempfile::TempDir;
use vault_core::vault::Vault;

fn setup() -> (TempDir, Vault) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let v = Vault::create(&tmp.path().join("v"), None).expect("vault");
    (tmp, v)
}

fn paths(hits: &[vault_core::vault::SearchHit]) -> Vec<String> {
    hits.iter().map(|h| h.path.clone()).collect()
}

#[test]
fn fts_finds_terms_and_ranks() {
    let (_tmp, v) = setup();

    v.write_note("meeting.md", "# Meeting\n\nthe quarterly budget review\n")
        .unwrap();
    v.write_note("grocery.md", "# Grocery\n\nmilk and eggs\n")
        .unwrap();
    v.write_note(
        "deep/notes/budget-plan.md",
        "# Plan\n\nbudget for next year\n",
    )
    .unwrap();

    let hits = v.search("budget", 20).expect("search");
    let mut got = paths(&hits);
    got.sort();
    assert_eq!(got, vec!["deep/notes/budget-plan.md", "meeting.md"]);

    // AND semantics: both terms must match
    let hits = v.search("budget quarterly", 20).expect("search");
    assert_eq!(paths(&hits), vec!["meeting.md"]);

    // snippet carries the matching line text
    let hits = v.search("quarterly", 20).expect("search");
    assert!(hits[0].matches[0].snippet.contains("quarterly"));
    assert!(hits[0].matches[0].line >= 1);
}

#[test]
fn external_edit_is_visible_without_reindex() {
    let (_tmp, v) = setup();

    v.write_note("a.md", "original content\n").unwrap();
    assert!(!v.search("original", 20).unwrap().is_empty());

    // another editor rewrites the file behind our back
    fs::write(v.root.join("a.md"), "totally rewritten body\n").unwrap();
    let hits = v
        .search("rewritten", 20)
        .expect("search after external edit");
    assert_eq!(paths(&hits), vec!["a.md"]);
    assert!(v
        .search("original", 20)
        .expect("stale term must vanish")
        .is_empty());
}

#[test]
fn externally_created_note_is_found() {
    let (_tmp, v) = setup();

    v.write_note("seed.md", "seed note\n").unwrap();
    let _ = v.search("seed", 20).unwrap(); // build the index

    fs::create_dir_all(v.root.join("inbox")).unwrap();
    fs::write(v.root.join("inbox/new.md"), "fresh externally added note\n").unwrap();

    let hits = v.search("externally", 20).expect("search new note");
    assert_eq!(paths(&hits), vec!["inbox/new.md"]);
}

#[test]
fn externally_deleted_note_disappears() {
    let (_tmp, v) = setup();

    v.write_note("gone.md", "phantom content\n").unwrap();
    v.write_note("stay.md", "real content\n").unwrap();
    let _ = v.search("content", 20).unwrap(); // index both

    fs::remove_file(v.root.join("gone.md")).unwrap();
    let hits = v.search("content", 20).expect("search after delete");
    assert_eq!(paths(&hits), vec!["stay.md"]);
}

#[test]
fn non_ascii_query_falls_back_to_scan() {
    let (_tmp, v) = setup();

    v.write_note("thai.md", "การประชุมประจำสัปดาห์\nบันทึกรายการสำคัญ\n")
        .unwrap();
    v.write_note("fr.md", "résumé of the meeting\ncafé notes\n")
        .unwrap();

    // Thai: no space-separated tokens — scan fallback must find it
    let hits = v.search("บันทึก", 20).expect("thai search");
    assert_eq!(paths(&hits), vec!["thai.md"]);

    // accented Latin matches via diacritic-insensitive tokenization
    let hits = v.search("café", 20).expect("accent search");
    assert_eq!(paths(&hits), vec!["fr.md"]);
}

#[test]
fn index_rebuild_converges_after_many_changes() {
    let (_tmp, v) = setup();

    for i in 0..10 {
        v.write_note(&format!("n{i}.md"), &format!("note number {i}\n"))
            .unwrap();
    }
    let _ = v.search("note", 20).unwrap();

    // edit half, delete a few, add some — all externally
    for i in 0..5 {
        fs::write(v.root.join(format!("n{i}.md")), format!("revised {i}\n")).unwrap();
    }
    fs::remove_file(v.root.join("n5.md")).unwrap();
    fs::remove_file(v.root.join("n6.md")).unwrap();
    fs::write(v.root.join("extra.md"), "an extra file\n").unwrap();

    let revised = v.search("revised", 20).expect("revised");
    assert_eq!(revised.len(), 5);
    let extra = v.search("extra", 20).expect("extra");
    assert_eq!(paths(&extra), vec!["extra.md"]);
    assert!(v.search("number 5", 20).expect("deleted gone").is_empty());
}

#[test]
fn long_thai_line_does_not_panic_on_snippet() {
    let (_tmp, v) = setup();

    let long_line = "ก".repeat(300); // 300 multi-byte chars, single line
    v.write_note("long.md", &format!("{long_line}\n")).unwrap();
    let hits = v.search("กกก", 20).expect("search long line");
    assert_eq!(paths(&hits), vec!["long.md"]);
    // snippet is char-truncated, never panics mid-UTF-8
    assert!(hits[0].matches[0].snippet.chars().count() <= 121);
}
