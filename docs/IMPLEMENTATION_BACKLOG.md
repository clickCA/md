# Implementation Backlog — reliability plan, ordered

**Status:** Working backlog for the reliability engineering plan. Each epic closes a
named gap from `docs/TEST_STRATEGY.md` (guarantee IDs REL-*, `PRODUCT_REQUIREMENTS.md`)
and carries acceptance criteria + Definition of Done. Ordered by risk to user data,
not by effort.

## E1 — Atomic note writes (REL-2) ✅ done

Direct `fs::write` replaced by same-dir temp + fsync + rename in `vault::atomic_write`;
used by `write_note`, sync materialization, and `save_image`. Crash-mid-write covered
by `write_tests.rs` (subprocess abort between stage and rename).

## E2 — Serialize mutating sync per vault (REL-9)

Gap: `vault_sync` / `git_action` run with no engine-level lock; only Git's ref locking
and a frontend `syncingRef` (auto-sync path only) prevent interleaving. A manual sync
can overlap an in-flight auto-sync.

- **Implementation:** per-vault mutation guard in vault-core (process-wide map
  `dir → mutex`), acquired by the sync cycle and the mutating git actions. Note
  read/write and search stay lock-free.
- **Acceptance:** two concurrent sync cycles of the same vault serialize (engine test
  asserts both complete, never interleave at the journal level); different vaults run
  in parallel; editing during sync is never blocked.
- **DoD:** `cargo test` new test; `docs/api.md` unchanged (internal guarantee).

## E3 — Guarded note writes: no stale-buffer overwrite (REL-7)

Gap: `note_write(dir, path, content)` overwrites disk unconditionally. The editor
keeps dirty buffers on refresh, but an autosave after an external modification
silently clobbers the newer disk content.

- **Implementation:** optional `base` argument (the disk content the editor last saw).
  Engine refuses (`typed error, e.g. io/stale`) when current disk bytes ≠ `base` and
  `base` is provided; UI on refusal: reload disk state, keep the editor buffer, mark
  conflict for user decision — never auto-overwrite either side.
- **Acceptance:** engine test — write with stale `base` fails, with matching `base`
  succeeds, without `base` behaves as today (compat for folder-summary/AI accept
  paths). Browser test — external modification then autosave surfaces conflict card
  instead of clobbering.
- **DoD:** `docs/api.md` row updated in the same commit (contract change).

## E4 — Real-git interop harness (REL-4, REL-5)

Gap: no automated loop where a *foreign* git client commits/pushes behind the app's
back. The product promise is ordinary-Git compatibility; it must be a regression test.

- **Implementation:** integration test driving the system `git` CLI as the foreign
  client (temp dirs, no network): app vault ↔ bare remote ↔ plain git clone; commit,
  rename, delete from git's side; app syncs; then reverse direction. Include a
  diverged-history case where the only resolutions are merge or conflict-copies, and
  pin that `force-publish`/`take-remote` are the only history-rewriting paths and both
  are explicit user actions.
- **Acceptance:** the plan's §11 two-device scenario passes automated, both
  directions, with `git fsck` clean and file contents asserted.
- **DoD:** new `tests/interop_tests.rs`; `git` CLI availability guarded/skipped with a
  loud note if absent.

## E5 — Property-based sync convergence (REL-4)

Gap: crash cases are hand-picked; nothing fuzzes operation *sequences*.

- **Implementation:** `proptest` over generated op sequences (create/edit/rename/
  delete/commit/sync on two clones, optional kill at a random state) asserting the
  invariants: no unexpected file disappears, every acknowledged save remains present
  (pre-kill state), re-sync converges, `git fsck` clean, index rebuilds to match disk.
- **Acceptance:** default proptest cases pass in CI within a time budget (cap cases,
  shrink on failure); nightly can afford more cases.
- **DoD:** `proptest` as dev-dependency only; seed failures become fixed regression
  tests in `sync_tests.rs`.

## E6 — Index rebuild on corruption (REL-6)

Gap: `Db::search_rebuild` exists and is tested but has no caller; correctness rests on
incremental drift repair + line-scan fallback.

- **Implementation:** detect the corruption path (FTS query error, or schema-version
  mismatch on open) → rebuild in one transaction → re-serve query. Also give the
  rebuild a defined trigger order relative to `search_update`.
- **Acceptance:** engine test — corrupt the FTS table (write garbage), next query
  still returns correct results after automatic rebuild; `PRAGMA integrity_check`
  clean.
- **DoD:** `search_tests.rs` additions; no API change.

## E7 — Nightly reliability tier (CI)

Gap: fault injection exists only in-test; nothing runs the expensive tiers regularly.

- **Implementation:** `nightly.yml` (schedule + manual dispatch): full Rust + browser
  suites, `bench_tests.rs` release run with comparison against a stored baseline,
  proptest with high case count (E5), soak loop (E8). Failures file an issue with the
  run link; never silent red.
- **Acceptance:** first green nightly run; baseline stored; regression thresholds
  agreed.
- **DoD:** workflow in `.github/workflows/`, badge documented in `RUN-PRODUCT.md`.

## E8 — Soak + mobile lifecycle (M3 hardening)

- 100 consecutive sync cycles across two clones; 10k-note workspace write→list→
  search→sync; 100 app-restart cycles (open vault, read, close) asserting journal
  sanity.
- Mobile: terminate the app during a pending 700 ms autosave and during sync
  (Android instrumentation later — engine-level equivalent first via kill tests).
- **DoD:** scripted in the nightly tier; targets recorded, not guessed.

## E9 — Docs debt (small, do with any touching commit)

- `RUN-PRODUCT.md` says auto-sync "fires by itself"; `api.md`/ADR say user-triggered
  with no background sync — reconcile.
- `RUN-PRODUCT.md` test counts are stale (34 frontend / 18 Rust → now ~277 / ~118).
- `docs/ARCHITECTURE.md` commands table (`pnpm` names) vs Makefile targets — verify
  both list the same gates.

## Not planned (deliberate)

- **Typed `SyncState` enum refactor**: the journal already persists per-state events
  and the cycle is linear per run; the crash tests prove recovery at every state. An
  enum adds type safety but no user-visible guarantee — revisit only when a
  non-linear cycle (e.g. parallel remotes) is actually introduced.
- **Repo restructure** (`apps/` + `packages/` split): already adjudicated by
  `ARCHITECTURE.md` (FND-09) — modules stay together until a real boundary benefit.
- **Filesystem watcher**: convergence-not-instantaneity is the documented design;
  revisit only if users report staleness on desktop.
