# UI ⇄ Rust Command Contract

**Status:** Authoritative (FND-12). Every Tauri command in `md-app/src-tauri/src/commands/`
is listed here with its argument names (camelCase as sent from the UI), result shape,
and error behavior. Rust sources are the implementation of record; this document is the
review gate — a PR that changes a command name, argument, DTO field, or error code must
update this file in the same commit.

## Error model (FND-13)

Commands reject with a structured payload (serialized from `error.rs::AppError`):

```json
{ "code": "auth", "message": "authentication required" }
```

| Code           | Meaning                                            | Typical trigger                          |
| -------------- | -------------------------------------------------- | ---------------------------------------- |
| `auth`         | Remote requires credentials                        | fetch/push against a protected remote    |
| `vault`        | Engine failure (git transport, journal, merge)     | corrupt repo, network failure            |
| `path-escape`  | Requested path is outside the vault root           | tampered client input                    |
| `invalid-input`| Malformed argument from the UI layer               | bad base64 image payload, bad action     |
| `io`           | Filesystem failure                                 | missing file, permission denied          |
| `internal`     | Unexpected state / bug                             | app-data dir unavailable                 |

The UI resolves all rejections through `src/lib/ipc.ts` (`errorMessage`, `isAuthError`),
which also accepts plain-string errors for transport paths outside Tauri's serializer.

Every command runs inside a `tracing` span named after the command; failures are logged
at `error` level with the span context. Verbosity is controlled by `RUST_LOG` (default `info`).

## Vault lifecycle & sync

| Command            | Arguments                     | Returns                                              |
| ------------------ | ----------------------------- | ---------------------------------------------------- |
| `default_vault_dir`| —                             | `string` — absolute default vault dir (created)      |
| `vault_probe`      | `dir`                         | `Probe { exists, isVault, remoteUrl?, noteCount? }`  |
| `vault_make`       | `dir`, `remoteUrl?`           | `Status` — opens or creates the vault, sets remote   |
| `vault_status`     | `dir`                         | `Status`                                             |
| `vault_sync`       | `dir`, `credentials?`         | `Sync { action, head?, remote?, conflicts[] }`       |

`Status = { root, head?, remoteMain?, pending, conflicts: Conflict[], lastRun: Journal? }`

- `Conflict = { path, conflictCopy, winner, at }`
- `Journal = { id, startedAt, finishedAt?, outcome?, events: [state, at][] }`
- `vault_sync` runs one idempotent cycle: commit pending → fetch → merge → push.
  It is **user-triggered**; there is no background auto-sync (deliberate, see ADR).
- **Threading:** every command that touches disk, git, or SQLite is `async` and
  runs on the async runtime's blocking pool (`commands::blocking`). Non-async
  Tauri commands execute inline on the main thread — a slow fetch there would
  freeze the window. Keep new heavy commands on this pattern.

## Notes

| Command         | Arguments                  | Returns                                          |
| --------------- | -------------------------- | ------------------------------------------------ |
| `note_list`     | `dir`                      | `string[]` — vault-relative `.md` paths, sorted  |
| `note_read`     | `dir`, `path`              | `string` — UTF-8 content                         |
| `note_write`    | `dir`, `path`, `content`   | `void` — atomic write through vault-core         |
| `note_delete`   | `dir`, `path`              | `void`                                           |
| `note_statuses` | `dir`                      | `NoteStatus[] = { path, status }` — `clean \| modified \| untracked` via blob-oid diff (no content I/O) |
| `note_base`     | `dir`, `path`              | `string?` — committed content at HEAD, `null` when untracked |
| `note_snapshot` | `dir`                      | `{ path, content, committed }[]` — everything the editor needs in one round trip (`committed` mirrors `note_base` semantics); preferred over the per-note fan-out |
| `note_move`     | `dir`, `from`, `to`        | `void` — rename, removes emptied parent folder   |
| `folder_create` | `dir`, `path`              | `void`                                           |
| `search_notes`  | `dir`, `query`             | `SearchHit[] = { path, matches: { line, snippet }[] }` (capped at 200 hits). Behavior: FTS5-indexed and bm25-ranked (see `docs/adr/2026-10-30-search-index.md`); the index is stat-verified before every query and updated incrementally on drift, so external edits are always reflected. Non-ASCII queries fall back to a line scan. |

## Files & images

| Command           | Arguments              | Returns                                                       |
| ----------------- | ---------------------- | ------------------------------------------------------------- |
| `save_image`      | `dir`, `data` (b64), `ext` | `string` — vault-relative path `assets/paste-<ms>.<ext>`   |
| `read_file_bytes` | `dir`, `path`          | `string` — base64 bytes (images render as data URLs)          |
| `vault_path`      | `dir`, `path`          | `string` — absolute path, for "reveal in file manager"        |

`read_file_bytes` and `vault_path` reject with `path-escape` when the resolved path
leaves the vault root.

## Git state & actions

| Command         | Arguments                              | Returns                                                        |
| --------------- | -------------------------------------- | -------------------------------------------------------------- |
| `git_state_cmd` | `dir`                                  | `GitState { remoteUrl?, head?, remote?, relation }`            |
| `git_action`    | `dir`, `action`, `credentials?`        | `GitState` — after performing the action                       |

`relation ∈ no-remote | empty | not-published | remote-only | in-sync | ahead | behind | diverged | unrelated | unknown`

`action ∈ push | take-remote | force-publish` — explicit, user-triggered operations.
`credentials = { username, password }` is used only for the duration of the call and is
never persisted or logged.

## Boundary rules

1. All cross-boundary DTOs are camelCase and defined once per side
   (`commands/dto.rs` ⇄ `src/types.ts`).
2. The UI never touches the filesystem or Git directly — every effect goes through a
   command listed here (Tauri plugins for dialogs/opener/clipboard-manager are the only
   exceptions).
3. `vault-core` knows nothing about Tauri; the command layer is the only adapter.
4. Adding a command: implement it in the matching `commands/*.rs` module, register it
   in `lib.rs`, document it here, and cover new behavior with tests where practical.
