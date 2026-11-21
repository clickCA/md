# Test Strategy — how each guarantee is proven

**Status:** Authoritative companion to `docs/PRODUCT_REQUIREMENTS.md` (the guarantees,
REL-*). This file maps every guarantee to the tests that hold it today and names the
gap where none exist. Gap closure is ordered in `docs/IMPLEMENTATION_BACKLOG.md`.

## Test layers in this repo

| Layer | Where | Notes |
| --- | --- | --- |
| Rust engine integration | `crates/vault-core/tests/*.rs` (53 tests) | real temp repos + real bare remotes; no Git mocking |
| Crash injection | `VAULT_SPIKE_ABORT_STATE` abort hook (`lib.rs`), driven via `vault-cli` subprocesses | aborts at `fetching/merging/committing/pushing` (sync) and `writing` (note save) |
| Rust unit | in-src (`exclude`, `links`, `gix_backend`) + `md-app/src-tauri` (argv/parsing pins) | |
| Browser component tests | `md-app/src/**/*.test.tsx` (40 files, ~277 tests) | Vitest in Playwright Chromium; Tauri boundary mocked once (`src/test/setup.ts`) |
| Performance snapshot | `make bench` (2k notes), `bench_tests.rs` | release-build only, never part of `make test` |

## Guarantee → proof map

| ID | Guarantee | Proven today | Gap |
| --- | --- | --- | --- |
| REL-1 | Acknowledged saves persist | `note_write` is temp+fsync+rename (`vault::atomic_write`); durability boundary stated in the requirements doc | — |
| REL-2 | Atomic writes | `write_tests.rs`: replace, crash-mid-write keeps old content + self-heal, bad-target failure | — |
| REL-3 | Git safety | `sync_tests.rs` conflict-copy cases; force-push only via explicit `git_action("force-publish")` (command surface, `api.md`) | no test pinning "no automatic force-push" |
| REL-4 | Sync recovery | `kill_tests.rs`: abort at every sync state → re-sync converges; conflict cycle survives abort | network-loss-during-push, disk failure during merge |
| REL-5 | External compatibility | `search_tests.rs` external edit/create/delete; sync converges two clones (`sync_tests.rs`) | no automated "foreign git client" interop loop (Zed/desktop git commits behind the app's back, app reconciles) |
| REL-6 | Index disposability | index is stat-verified per query with line-scan fallback (`vault.rs`); `search_tests.rs` covers rebuild-after-changes | `Db::search_rebuild` has no caller on the corruption path |
| REL-7 | Editor consistency | dirty notes keep their buffer on refresh (`useVault.ts`); AI stale-invalidation tested (`NoteEditorAi.test.tsx`) | `note_write` is blind — a stale autosave can overwrite newer disk content; no concurrent-edit detector |
| REL-8 | AI safety | tool-disabled single-shot backend pinned by argv tests; accept/discard/stale tested in browser suite | — |
| REL-9 | One mutation at a time | Git ref locking is the only guard; frontend `syncingRef` covers auto-sync only | no engine-level per-vault serialization; manual sync can overlap auto-sync |
| REL-10 | Honest status | sync journal records state+outcome; typed errors (`api.md` error model) | no test asserting partial cycles never report success |
| REL-11 | Path safety | `path-escape` rejections (command layer) | — |
| REL-12 | Vault lifetime | clone cases incl. empty remote (`sync_tests.rs`), branch round-trips (`branch_tests.rs`) | kill-during-clone |
| cross-platform | Same contract per platform | CI runs Linux tests; releases build Win/macOS/Linux/Android | no Windows/macOS/Android test execution of the Rust suite; mobile lifecycle (kill during save/sync) untested |
| soak/perf | Long-run behavior | `make bench` snapshot | no repeated-cycle soak (100 syncs), no 10k+ file run in CI |

## Deliberate design choices (not gaps)

- **No filesystem watcher**: the index is stat-verified on every query and the full
  tree is re-read on every sync cycle; external changes surface on next search/sync
  or on window focus (`autoSyncNow` triggers). This is the mobile-portable design;
  the guarantee is convergence (`REL-5`), not instantaneity.
- **`git` CLI is not used for vault operations** (in-process gix + libgit2 only);
  tests shell out to `git` solely to *inspect* fixtures, and the planned interop
  harness will use it to *act* as a foreign client.

## CI execution tiers (from the reliability plan)

| Tier | Runs | Today |
| --- | --- | --- |
| Every PR | lint, format, typecheck, browser tests, Rust tests, builds | `ci.yml` — done |
| Merge to main | + landing dist sync guard | done |
| Nightly | fault injection beyond kill tests, property-based runs, soak, bench regression | missing (backlog E7) |
