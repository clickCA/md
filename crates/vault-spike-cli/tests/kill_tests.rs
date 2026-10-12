use std::path::Path;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_vault-spike-cli");

fn run(args: &[&str]) -> String {
    let out = Command::new(BIN).args(args).output().expect("spawn cli");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "command {args:?} failed: {text}"
    );
    text
}

fn run_aborting(args: &[&str], state: &str) {
    let out = Command::new(BIN)
        .args(args)
        .env("VAULT_SPIKE_ABORT_STATE", state)
        .output()
        .expect("spawn cli");
    assert!(
        !out.status.success(),
        "expected abort at {state}, but succeeded: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}

fn remote_main_oid(remote: &Path) -> String {
    let out = Command::new("git")
        .args(["--git-dir", &remote.to_string_lossy(), "rev-parse", "refs/heads/main"])
        .output()
        .expect("git rev-parse");
    assert!(out.status.success(), "rev-parse failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn interrupted_sync_at_every_state_converges() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    let remote_str = remote.to_string_lossy().to_string();
    run(&["init-remote", &remote_str]);

    let a = tmp.path().join("a").to_string_lossy().to_string();
    let b = tmp.path().join("b").to_string_lossy().to_string();
    run(&["init", &a, &remote_str]);
    run(&["init", &b, &remote_str]);

    run(&["edit", &a, "shared.md", "one\ntwo\nthree\n"]);
    run(&["sync", &a]);
    run(&["sync", &b]);

    run(&["edit", &a, "shared.md", "ONE\ntwo\nthree\n"]);
    run(&["sync", &a]);
    let mut prev_remote = remote_main_oid(&remote);

    for state in ["fetching", "merging", "committing", "pushing"] {
        run(&["edit", &b, "shared.md", &format!("one\ntwo\nthree\nB-{state}\n")]);
        run(&["edit", &a, "shared.md", &format!("ONE\ntwo\nthree\nA-{state}\n")]);
        run(&["sync", &a]);
        prev_remote = remote_main_oid(&remote);

        run_aborting(&["sync", &b], state);
        let r = remote_main_oid(&remote);
        if state != "pushing" {
            assert_eq!(r, prev_remote, "remote must not move on abort at {state}");
        }
        run(&["sync", &b]);
        let r = remote_main_oid(&remote);
        assert_ne!(r, prev_remote, "remote must advance after recovery at {state}");
        run(&["sync", &a]);
        let r2 = remote_main_oid(&remote);
        assert_eq!(r, r2);
        prev_remote = r2;
    }

    let a_text = std::fs::read_to_string(tmp.path().join("a/shared.md")).unwrap();
    let b_text = std::fs::read_to_string(tmp.path().join("b/shared.md")).unwrap();
    assert_eq!(a_text, b_text);
    let winner_is_b = b_text.contains("B-pushing");
    let winner_is_a = b_text.contains("A-pushing");
    assert!(
        winner_is_b ^ winner_is_a,
        "winner must contain exactly one version: {b_text:?}"
    );
    let copies: Vec<String> = std::fs::read_dir(tmp.path().join("b"))
        .unwrap()
        .filter_map(|d| d.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with("shared.conflict-"))
        .collect();
    let all_copies: String = copies
        .iter()
        .filter_map(|c| std::fs::read_to_string(tmp.path().join("b").join(c)).ok())
        .collect();
    let loser_marker = if winner_is_a { "B-pushing" } else { "A-pushing" };
    assert!(
        all_copies.contains(loser_marker),
        "loser preserved in a conflict copy: {copies:?}"
    );
}

#[test]
fn interrupted_merge_conflict_still_converges() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    let remote_str = remote.to_string_lossy().to_string();
    run(&["init-remote", &remote_str]);

    let a = tmp.path().join("a").to_string_lossy().to_string();
    let b = tmp.path().join("b").to_string_lossy().to_string();
    run(&["init", &a, &remote_str]);
    run(&["init", &b, &remote_str]);

    run(&["edit", &a, "clash.md", "same\n"]);
    run(&["sync", &a]);
    run(&["sync", &b]);

    run(&["edit", &a, "clash.md", "A-VERSION\n"]);
    run(&["sync", &a]);

    run(&["edit", &b, "clash.md", "B-VERSION\n"]);
    run_aborting(&["sync", &b], "merging");
    run_aborting(&["sync", &b], "committing");

    let status = run(&["status", &b]);
    assert!(status.contains("conflict:"), "expected conflict report: {status}");

    run(&["sync", &b]);
    run(&["sync", &a]);
    let a_text = std::fs::read_to_string(tmp.path().join("a/clash.md")).unwrap();
    let b_text = std::fs::read_to_string(tmp.path().join("b/clash.md")).unwrap();
    assert_eq!(a_text, b_text);

    let copies: Vec<_> = std::fs::read_dir(tmp.path().join("a"))
        .unwrap()
        .filter_map(|d| d.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with("clash.conflict-"))
        .collect();
    assert_eq!(copies.len(), 1, "conflict copy synced: {copies:?}");
}
