# Product Requirements — reliability guarantees

**Status:** Authoritative for release gating (companion to `ARCHITECTURE.md` and `api.md`).
This file states *required behavior* — what must hold for a release to ship. Where each
guarantee is tested lives in `docs/TEST_STRATEGY.md`; the work to close any gap lives in
the engineering backlog.

Derived from the reliability-engineering plan (Phase 0), grounded in the product as
shipped: plain Markdown + plain Git, one Git repository per vault, SQLite as a
rebuildable index, sync as an explicit user-triggered cycle.

## The promise

> Your notes are ordinary Markdown files in an ordinary Git repository. Your vault
> remains usable even when the app, the network, the sync operation, or the search
> index fails.

If Quire disappeared tomorrow, the vault loses nothing (`RUN-PRODUCT.md` §5). Every
requirement below serves that promise.

## Product boundary (non-goals)

Per `RUN-PRODUCT.md` §7, out of scope on purpose: cloud service, realtime
collaboration, plugins, bundled AI models, automatic conflict auto-resolution
(resolving conflicts stays a human decision).

## Reliability guarantees (release-blocking)

| ID | Guarantee | Required behavior |
| --- | --- | --- |
| REL-1 | Data integrity | No acknowledged save is silently lost. Once `note_write` reports success, the content is persisted to the platform's supported filesystem guarantees (see durability boundary). |
| REL-2 | Atomic writes | A save interrupted at any point leaves the previous complete file or the new complete file — never a partial file. |
| REL-3 | Git safety | Never force-push *automatically* and never discard uncommitted user changes to apply a sync. Force-publishing local history is allowed only as an explicit, user-invoked action (paired with take-remote as the opposite resolution). Sync conflicts preserve both versions (conflict-copies), never silently pick a winner. |
| REL-4 | Sync recovery | An interrupted sync cycle (process kill, network loss, crash) leaves the vault valid, and the next sync converges without user repair. |
| REL-5 | External compatibility | Files created, edited, renamed, or deleted by other tools (Zed, desktop git, another clone) are picked up by the app — file tree, search, and sync all converge to the filesystem's actual state. |
| REL-6 | Index disposability | Deleting `index.db` never loses user data; search and journal are reconstructible from the Markdown files and Git alone. |
| REL-7 | Editor consistency | The editor must not overwrite newer filesystem content with a stale buffer; external modification vs. unsaved local edits is detected and surfaced, not auto-resolved. |
| REL-8 | AI safety | AI features propose changes; nothing is written without an explicit accept; an accepted proposal applies only its intended diff; a note edited mid-request invalidates the stale proposal. |
| REL-9 | One mutation at a time | Only one mutating sync cycle per vault at a time; duplicate sync requests cannot interleave. Editing notes is never blocked by a running fetch. |
| REL-10 | Honest status | Sync success is reported only after verification; a partially completed operation is never reported as success. Failures are visible in the sync panel and typed (`auth` vs `vault` vs `io`). |
| REL-11 | Path safety | No operation may read or write outside the vault root (`path-escape` is rejected). |
| REL-12 | Vault lifetime | Open, close, clone, and switch vaults without corrupting the journal, the repo, or in-flight state. |

### Durability boundary

No software survives every hardware failure. The boundary is: once a save command
returns success, the bytes have been handed to the OS filesystem with a completed
write-then-rename; loss beyond that point (OS crash before fsync propagation, disk
failure) is out of scope and mitigated by Git history + the user's own backups.
This boundary is a product statement, not an implementation shortcut — the write path
must still be atomic per REL-2.

## Acceptance scenario (the core regression suite)

The release-blocking end-to-end scenario, from the reliability plan §11, is the
two-device loop with desktop Git in the middle:

1. Device A: create + edit + save + sync.
2. Device B: pull, search, edit another note, sync.
3. Desktop Git: modify `note.md` externally, commit, push.
4. Device A: detect external change, sync, reconcile; resolve conflict-copies if any.
5. Verify: every expected file exists with expected content; no acknowledged change
   lost; Git history valid; search results correct; no unresolved sync state.

Repeat with fault injection: kill during save, network loss during sync, same-file
concurrent edits, different-file concurrent edits, kill during merge, device switch
with unsaved editor content. Automation of this loop is tracked in the test strategy.

## Maturity ladder

| Level | Definition | Status |
| --- | --- | --- |
| M1 Functional | Main features work under normal conditions | Reached — editor, search, sync, conflicts, AI proposals all shipped (`RUN-PRODUCT.md` tour) |
| M2 Resilient | Concurrency, failures, recovery, external changes handled and *tested* | In progress — sync crash convergence is tested (`kill_tests.rs`); the fault-injection and interop matrix is the gap |
| M3 Hardened | Validated across platforms, large workspaces, long-running workloads | Partially — Android ships, `make bench` exists; soak/nightly tiers do not |

The gate for inviting serious users is M2; the gate for "dependable long-term note
storage" positioning is M3.
