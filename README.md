# md

Personal Markdown vault with a Git-backed sync engine. Spike for the cross-platform
app (macOS / Linux / iOS / iPadOS / Android): Tauri 2 + React UI on a shared Rust core.

## Status: sync spike (complete)

The vertical slice — vault → edit note → commit → sync → resolve conflict → crash
recovery — is implemented and tested:

- `crates/vault-core` — vault, Git backend (`GitBackend` trait), sync state machine,
  three-way line merge (imara-diff), LWW conflict copies, SQLite journal
- `crates/vault-spike-cli` — test harness (`init-remote`, `init`, `edit`, `rm`,
  `sync`, `status`)
- Merge policy: non-overlapping edits auto-merge; overlapping edits resolve
  last-writer-wins with the loser preserved as `note.conflict-<ts>.md`;
  edit beats delete (deleted version preserved as a conflict copy)
- All sync operations idempotent; re-running after a kill at any state converges

Run the suite:

```
cargo test
```

Design and the gitoxide evaluation (go/no-go: swap transport to libgit2 for push):
[docs/design/sync-spike.md](docs/design/sync-spike.md)

## Toolchain

Rust 1.94 (pinned in `rust-toolchain.toml`).
