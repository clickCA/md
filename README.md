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
│  crates/vault-core  bin: vault-cli           │
│    (test harness + crash-injection tests)    │
└──────────────────────────────────────────────┘
Files + SQLite index per vault · standard Git remote · single main branch
```

- **Merge policy**: non-overlapping edits auto-merge (line-level three-way);
  overlapping edits resolve last-writer-wins, loser preserved as
  `note.conflict-<ts>.md` and synced; edit beats delete (deleted version preserved)
- **Recovery**: every sync is journaled and idempotent — re-running after a kill
  at any state transition converges, and the remote ref only moves forward
- **Sync promise**: immediate sync when the app is active — auto-sync fires
  ~5 s after edits and on app focus (toggle in vault settings); opportunistic
  on mobile background windows (never guaranteed by the OS)
- **Search**: FTS5 index in the per-vault SQLite, stat-verified before every
  query and rebuilt on drift (external edits are always visible); non-ASCII
  queries (Thai, CJK, …) fall back to a line scan — see
  [docs/adr/2026-10-30-search-index.md](docs/adr/2026-10-30-search-index.md)

## Status

| Milestone | State |
| --------- | ----- |
| Sync spike: engine + merge + crash recovery, desktop test suite | ✅ done (9/9 tests) |
| Transport decision: hybrid gix + libgit2 push | ✅ done |
| Tauri 2 desktop app (macOS/Linux) wired to the core | ✅ done |
| Mobile validation: same suite on Android + iOS device | ⬜ next |
| Editor UX, search index, background scheduling | ⬜ backlog |

Full design + gitoxide evaluation log:
[docs/adr/2026-10-12-git.md](docs/adr/2026-10-12-git.md)

## Commands

One entry point from the repo root — `make` orchestrates across ecosystems;
each ecosystem keeps its native tooling (pnpm owns JS scripts, cargo owns
Rust invocations, and neither duplicates the other):

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `make setup`        | Install dependencies (pnpm + cargo fetch) |
| `make dev`          | Run the desktop app (Tauri + Vite)        |
| `make lint`         | ESLint + clippy (warnings are errors)     |
| `make format-check` | Verify Prettier + rustfmt formatting      |
| `make typecheck`    | TypeScript, no emit                       |
| `make test`         | Vitest + cargo test over both workspaces  |
| `make build`        | Frontend build + Rust workspace compile   |
| `make check`        | Full verification suite (mirrors CI)      |
| `make clean`        | Remove build artifacts                    |

Granular targets: `lint-js` / `lint-rust`, `test-js` / `test-rust`,
`format-js` / `format-rust` (plus `-check` variants), `build-js` / `build-rust`.
Run `make` with no arguments to list them.

## Running the desktop app

See [md-app/README.md](md-app/README.md). Quick start (from the repo root):

```
make setup                                      # install everything
make dev                                        # full desktop app, hot reload
pnpm --filter md-app dev                        # frontend-only dev server
```

## Test suite

```
make test-rust      # 18 tests: happy path, concurrent edits, delete-vs-edit,
                    # offline-then-online, nested dirs, line-merge units,
                    # SIGKILL convergence at every sync state
make test-js        # frontend suite (Vitest)
make check          # every quality gate in one shot
```

Quality gates and layout are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the UI ⇄ Rust command contract is
[docs/api.md](docs/api.md).

## Toolchain

- Rust 1.99.1 (pinned in `rust-toolchain.toml`)
- pnpm 12 (frontend), Node ≥ 26, GNU make (developer entry point)
- Linux build deps: webkit2gtk-4.1, libgit2 ≥ 1.9 (mobile builds vendor libgit2 via cmake)
