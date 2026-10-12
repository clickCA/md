# md

Personal Markdown vault with a Git-backed sync engine. Target: one portable vault on
macOS, Linux, iOS/iPadOS, and Android — Tauri 2 + React UI on a shared Rust core.

## Architecture

```
┌──────────────────────────────────────────────┐
│  md-app/  Tauri 2 + React + TypeScript UI    │
├──────────────────────────────────────────────┤
│  crates/vault-core  (shared Rust engine)     │
│    vault      notes CRUD, FS scan            │
│    git        GitBackend trait               │
│               ├ gix: objects/fetch/merge     │
│               └ git2 (libgit2): push         │
│    merge      diff3 line merge (imara-diff)  │
│    sync       state machine + recovery       │
│    db         SQLite journal + conflicts     │
├──────────────────────────────────────────────┤
│  crates/vault-spike-cli  test harness        │
└──────────────────────────────────────────────┘
Files + SQLite index per vault · standard Git remote · single main branch
```

- **Merge policy**: non-overlapping edits auto-merge (line-level three-way);
  overlapping edits resolve last-writer-wins, loser preserved as
  `note.conflict-<ts>.md` and synced; edit beats delete (deleted version preserved)
- **Recovery**: every sync is journaled and idempotent — re-running after a kill
  at any state transition converges, and the remote ref only moves forward
- **Sync promise**: immediate sync when the app is active; opportunistic on
  mobile background windows (never guaranteed by the OS)

## Status

| Milestone | State |
| --------- | ----- |
| Sync spike: engine + merge + crash recovery, desktop test suite | ✅ done (9/9 tests) |
| Transport decision: hybrid gix + libgit2 push | ✅ done |
| Tauri 2 desktop app (macOS/Linux) wired to the core | ✅ done |
| Mobile validation: same suite on Android + iOS device | ⬜ next |
| Editor UX, search index, background scheduling | ⬜ backlog |

Full design + gitoxide evaluation log:
[docs/design/sync-spike.md](docs/design/sync-spike.md)

## Test suite

```
cargo test          # 9 tests: happy path, concurrent edits, delete-vs-edit,
                    # offline-then-online, nested dirs, line-merge units,
                    # SIGKILL convergence at every sync state
```

## Running the desktop app

See [md-app/README.md](md-app/README.md). Quick start:

```
cd md-app && pnpm install && pnpm tauri dev    # dev, hot reload
cargo build --release -p md-app                # self-contained binary
```

## Toolchain

- Rust 1.94 (pinned in `rust-toolchain.toml`)
- pnpm 12 (frontend), Node ≥ 20
- Linux build deps: webkit2gtk-4.1, libgit2 ≥ 1.9 (mobile builds vendor libgit2 via cmake)
