use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_vault-cli");

fn run(args: &[&str]) -> String {
    let out = Command::new(BIN).args(args).output().expect("spawn cli");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "command {args:?} failed: {text}");
    text
}

/// `init-remote` creates missing parent directories, so a fresh
/// `<dir>/remote.git` path works without hand-setting up the tree (the
/// `make bench` target relies on this).
#[test]
fn create_remote_creates_missing_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("deep/nested/remote.git");
    run(&["init-remote", &remote.to_string_lossy()]);
    assert!(remote.join("HEAD").exists() || remote.is_dir());
}

/// The bench is a smoke-tested CLI surface, not a perf gate: this runs a
/// tiny corpus in debug mode and asserts the phases execute and the corpus
/// really lands on disk (and in git). Real numbers come from
/// `make bench` in release mode against thousands of notes.
#[test]
fn bench_generates_corpus_and_times_engine_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    let vault = tmp.path().join("vault");
    let r = remote.to_string_lossy().to_string();
    let v = vault.to_string_lossy().to_string();

    run(&["init-remote", &r]);
    run(&["init", &v, &r]);

    let out = run(&["bench", &v, "40", "30"]);
    assert!(out.contains("bench vault="), "{out}");
    assert!(out.contains("write 40 notes"), "{out}");
    assert!(out.contains("initial sync"), "{out}");
    assert!(out.contains("note_list (40 notes)"), "{out}");
    assert!(out.contains("note_snapshot (40 notes)"), "{out}");
    assert!(out.contains("search cold  \"meeting\""), "{out}");
    assert!(out.contains("search warm  \"meeting\""), "{out}");
    assert!(out.contains("search exact \"token20\""), "{out}");
    assert!(out.contains("edit + sync cycle"), "{out}");

    // The corpus exists on disk and the final cycle synced (worktree clean
    // against HEAD: note-00000's edited content was committed and pushed).
    assert!(vault.join("notes/note-00039.md").exists());
    let status = run(&["status", &v]);
    assert!(status.contains("worktree: clean"), "{status}");
}
