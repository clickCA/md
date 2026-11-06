//! Broken internal link report: extraction + resolution over the visible
//! note set. The guarantee under test: excluded notes are neither scanned
//! as sources nor accepted as targets, renames/nested folders resolve, and
//! every reported row points at a real, exact location.

use std::fs;
use tempfile::TempDir;
use vault_core::links::{self, LinkKind};
use vault_core::vault::Vault;

fn setup() -> (TempDir, Vault) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let v = Vault::create(tmp.path(), None).expect("vault");
    (tmp, v)
}

fn broken(v: &Vault) -> Vec<(String, String, usize)> {
    links::broken_links(v)
        .expect("broken links")
        .into_iter()
        .map(|l| (l.source, l.target, l.line))
        .collect()
}

#[test]
fn resolves_paths_stems_and_relative_links() {
    let (_t, v) = setup();

    v.write_note("target.md", "found\n").unwrap();
    v.write_note("Areas/Dev/notes.md", "deep\n").unwrap();
    v.write_note("notes/source.md", "linking\n").unwrap();
    v.write_note("notes/source2.md", "sibling\n").unwrap();
    v.write_note("notes/my note.md", "spaced name\n").unwrap();
    v.write_note(
        "notes/source.md",
        "[[target]] by stem, [[Areas/Dev/notes]] by path,\n\
         [relative](source2.md) and [up](../target.md) and [spaced](my%20note.md),\n\
         [aliased](https://example.com) and [anchor](#sec) and [image](pic.png) skipped\n",
    )
    .unwrap();

    assert_eq!(broken(&v), Vec::new(), "every note link resolves");
}

#[test]
fn reports_unresolved_references_with_location() {
    let (_t, v) = setup();

    v.write_note("notes/a.md", "first line\n[[ghost]] here\n")
        .unwrap();
    v.write_note("b.md", "[missing.md](nope/missing.md)\n")
        .unwrap();

    let rows = broken(&v);
    assert_eq!(
        rows,
        vec![
            ("b.md".into(), "nope/missing.md".into(), 1),
            ("notes/a.md".into(), "ghost".into(), 2),
        ],
        "ordered by (source, line, target)"
    );

    let all = links::broken_links(&v).unwrap();
    assert_eq!(all[1].kind, LinkKind::Wiki);
    assert_eq!(all[0].kind, LinkKind::Markdown);
    assert_eq!(all[1].text, "ghost");
}

#[test]
fn excluded_notes_are_never_sources_nor_targets() {
    let (_t, v) = setup();

    v.write_note(".quireignore", "private/\nhidden.md\n")
        .unwrap();
    v.write_note("private/secret.md", "[[anything]] not scanned\n")
        .unwrap();
    v.write_note("hidden.md", "excluded target\n").unwrap();
    v.write_note("open.md", "[[hidden]] points into an excluded note\n")
        .unwrap();

    assert_eq!(
        broken(&v),
        vec![("open.md".into(), "hidden".into(), 1)],
        "the excluded source is not scanned; the excluded target is broken"
    );
}

#[test]
fn rename_survival_through_stem_and_suffix_matches() {
    let (_t, v) = setup();

    // Link written against a note later moved into a nested folder: the
    // stem still resolves, and a unique folder-suffix link survives the
    // rename of the parent folder.
    v.write_note("a/old-parent/renamed.md", "moved\n").unwrap();
    v.write_note(
        "linker.md",
        "[[renamed]] and [suffix](old-parent/renamed.md)\n",
    )
    .unwrap();
    assert_eq!(broken(&v), Vec::new());

    // Move the note deeper; stem still unique, but the suffix path changed.
    fs::remove_file(v.root.join("a/old-parent/renamed.md")).unwrap();
    fs::remove_dir(v.root.join("a/old-parent")).unwrap();
    v.write_note("a/new-parent/renamed.md", "moved again\n")
        .unwrap();
    let rows = broken(&v);
    assert_eq!(
        rows.len(),
        1,
        "stem resolves, the old suffix path is broken"
    );
    assert_eq!(
        rows[0],
        ("linker.md".into(), "old-parent/renamed.md".into(), 1)
    );
}

#[test]
fn ambiguous_suffix_links_are_broken_not_guessed() {
    let (_t, v) = setup();

    v.write_note("a/x/dup.md", "one\n").unwrap();
    v.write_note("b/x/dup.md", "two\n").unwrap();
    v.write_note("l.md", "[ambiguous](x/dup.md)\n").unwrap();

    assert_eq!(
        broken(&v),
        vec![("l.md".into(), "x/dup.md".into(), 1)],
        "two suffix matches — no silent guess"
    );
}
