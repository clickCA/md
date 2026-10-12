# Sync Spike Technical Design

**Goal**: Validate the riskiest assumption first — that a shared Rust core can perform
reliable Git sync and conflict recovery on all five platforms — before any editor UI is built.

**Exit criterion**: `gitoxide` completes the sync-and-recovery test suite without substantial
custom Git plumbing. If it cannot, this document records exactly what is missing and we fall
back to `libgit2` (accepting C cross-compilation for mobile targets).

## 1. Scope (vertical slice only)

1. Create/open a vault (directory + git init)
2. Edit a note (plain file write; the CLI test harness triggers edits)
3. Commit
4. Sync (fetch → merge → push)
5. Resolve a conflict (both automatic and manual paths)
6. Recover from an interrupted sync (re-run to convergence)

**Out of scope**: UI, search index, credentials on device, background scheduling,
remotes other than a bare local repo.

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│  Spike harness (CLI: vault-spike)           │
│  commands: init, edit, commit, sync, status │
├─────────────────────────────────────────────┤
│  Rust core crate: vault-core               │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ vault       │  │ sync engine          │  │
│  │ - notes CRUD│  │ - state machine      │  │
│  │ - paths     │  │ - merge policy       │  │
│  │             │  │ - conflict handling  │  │
│  │             │  │ - retries/recovery   │  │
│  └─────────────┘  └──────────────────────┘  │
│         git abstraction layer (gitoxide)    │
└─────────────────────────────────────────────┘
```

The git abstraction layer is a thin trait (`GitBackend`) so swapping gitoxide → libgit2 is
confined to one module. This is what makes the fallback decision cheap.

## 3. Sync engine

### State machine

```
Idle → Fetching → Merging → Committing → Pushing → Idle
                ↘ Conflicted (awaiting resolution) ↗
any state ↘ Failed (retryable error) → Idle
```

- Single-branch (`main`), linear history, no rebase of published commits.
- Every transition is journaled to SQLite so an interrupted sync is detectable and resumable.
- All operations idempotent: re-running `sync` after a crash at any point converges.

### Merge policy (confirmed)

- **Non-overlapping concurrent edits**: line-level three-way merge, auto-commit.
- **Overlapping edits to the same file**: last-writer-wins for the newer commit, loser
  preserved as `note.conflict-<timestamp>.md`, both versions listed in a conflict report
  row in SQLite.
- **Delete vs. edit**: edit wins, deleted version preserved as a conflict copy.

### Retry & recovery

- Push/fetch retried with capped exponential backoff (network class errors only).
- Interrupted push: verify remote tip before retry — never force-push.
- Recovery = re-run sync; journal + idempotency guarantee convergence.
  Tested by killing the process at each state transition.

## 4. Storage

- Notes: plain `.md` files in the vault directory (user-visible on desktop;
  app-sandboxed on mobile for the spike).
- SQLite (one DB per vault, `index.db`): sync journal, conflict report, note metadata.
  Derived data only — deleting it and re-indexing must always be possible.

## 5. Platform triggers (spike: desktop only)

| Trigger        | Spike | Later              |
| -------------- | ----- | ------------------ |
| After commit   | CLI   | all platforms      |
| App foreground | —     | mobile             |
| Timer/resume   | —     | desktop            |
| Background     | —     | opportunistic only |

The engine exposes only `sync(vault) -> SyncResult`; scheduling is never inside the core.

## 6. Test suite (acceptance gate)

Table-driven, using a local bare repo as the remote:

1. **Happy path**: clone → edit → commit → sync on two clients alternately.
2. **Concurrent non-overlapping edits**: both merge cleanly.
3. **Concurrent overlapping edits**: conflict copy + report generated, sync completes.
4. **Delete vs. edit**: conflict copy, sync completes.
5. **Interrupted sync**: SIGKILL at each state transition; re-run converges; no data
   loss; remote ref only moves forward.
6. **Offline then online**: commits accumulate locally, single sync reconciles.

Tests run on the host. Mobile validation (same suite via the Tauri app shell,
foreground sync only) is milestone 2.

## 7. gitoxide evaluation log

Running log of every place gitoxide fell short. Decision rule:
**> 2 weeks of plumbing or any correctness gap in merge/push → switch to libgit2.**

| Date       | Area            | Finding                                                                                                        | Impact                                                                    |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 2026-10-12 | push            | `gix` 0.89 has **no push support at all** (no receive-pack implementation anywhere, incl. `gix-protocol`)        | Spike shells out to system `git push`; **blocking for mobile** (no git binary on iOS/Android) |
| 2026-10-12 | config          | `config_snapshot_mut()` updates in-memory config only, never persists to `.git/config`                          | Workaround: `config_file_mut()` transaction + repo reopen                   |
| 2026-10-12 | commits/trees   | No high-level "stage + commit" over a worktree; index manipulation not used. Trees/commits written manually     | ~120 lines custom plumbing (tree building with git sort order) — acceptable |
| 2026-10-12 | merge           | No tree/file merge in `gix`; three-way line merge built on `imara-diff` (`Diff::compute` + `hunks()`)            | ~200 lines; imara-diff API is clean and sufficient                        |
| 2026-10-12 | identity         | Isolated config has no committer; ref updates fail ("reflog messages need a committer")                         | Workaround: `committer_or_set_generic_fallback()` on open                  |
| 2026-10-12 | fetch           | `find_remote` + bisync `connect`/`prepare_fetch`/`receive` works on local remotes with blocking feature          | None — clean                                                              |

### Go / no-go

**Verdict: conditional no-go for pure gitoxide.** The merge, recovery, and conflict model
all passed the full test suite (9/9, incl. SIGKILL convergence at every state transition)
with modest custom plumbing. But push is a hard capability gap, and mobile targets cannot
shell out to git.

**Recommendation for the app:**
- Keep the `GitBackend` trait and the entire sync/merge/recovery engine as built.
- Swap the transport layer to **libgit2** (`git2` crate) for push (and optionally fetch),
  which compiles for iOS/Android via cargo.
- Alternatively, hybrid: gix for object/tree/merge plumbing, libgit2 only for push.
- Re-evaluate gitoxide when its push support lands.

## 8. Repository layout

```
md/
├── crates/vault-core/        # engine + git abstraction
├── crates/vault-spike-cli/   # test harness
└── docs/design/sync-spike.md
```
