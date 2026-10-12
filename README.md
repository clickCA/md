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

Design and the gitoxide evaluation (go/no-go: hybrid — libgit2 for push):
[docs/design/sync-spike.md](docs/design/sync-spike.md)

## Tauri app (desktop)

`md-app/` — Tauri 2 + React + TypeScript shell wired to the same `vault-core`
(sync, notes, status, conflict report). Package manager: **pnpm 12**.

```
# dev (vite + tauri, hot reload)
cd md-app && pnpm install && pnpm tauri dev

# self-contained release binary (no dev server needed)
cargo build --release -p md-app   # → target/release/md-app
```

Note: a debug build without the dev server shows "could not connect to
localhost:1420" — the debug build loads `devUrl`. Use `pnpm tauri dev` or
the release binary.

Commands exposed to the UI: `vault_open`, `vault_init`, `vault_status`,
`vault_sync`, `note_read`, `note_write`, `note_delete`.

## Toolchain

Rust 1.94 (pinned in `rust-toolchain.toml`). pnpm 12 for the frontend.
