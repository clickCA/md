# Architecture & Package Boundaries

**Status:** Authoritative for Phase 1 (FND-09). The layout below reflects the repository
as it exists; the plan's `apps/` + `packages/` sketch is a target, not a mandate — modules
stay together until there is a real reuse or dependency-boundary benefit.

## Repository layout

```
md/                          ← repo root: Cargo workspace + pnpm workspace
├── crates/
│   └── vault-core/          ← Rust domain core (engine)
│       ├── src/vault.rs     ←   vault lifecycle, note ops, materialization
│       ├── src/gix_backend.rs ←  Git transport (gix + libgit2 push), behind GitBackend
│       ├── src/sync.rs      ←   sync state machine (fetch/merge/commit/push)
│       ├── src/merge.rs     ←   line-level three-way merge (imara-diff)
│       └── src/db.rs        ←   SQLite journal + conflict records (rebuildable index)
├── md-app/                  ← Tauri 2 application (the only JS package today)
│   ├── src/                 ← React UI (presentation + hooks)
│   │   ├── components/quire/   live editor, viewer, panels
│   │   ├── hooks/useVault.ts   application state over the command surface
│   │   └── lib/                pure helpers (ipc, images, vault model, blocks)
│   └── src-tauri/           ← Tauri shell (adapter layer)
│       ├── src/commands/    ←   THE UI ⇄ Rust boundary (see docs/api.md)
│       └── src/error.rs     ←   structured AppError → { code, message }
└── docs/                    ← adr/, api.md, this file
```

## Layers and dependency direction

```
React UI (md-app/src)          TypeScript, no fs/git access
      │  invoke("cmd", args)   only via the documented command surface
      ▼
Tauri commands (md-app/src-tauri/src/commands)   adapter: DTO ⇄ domain, AppError, tracing
      │  vault-core public API
      ▼
vault-core (crates/)           Rust engine: knows nothing about Tauri
      │
      ├── gix + git2/libgit2    Git transports (in-process — never a git subprocess)
      ├── rusqlite              journal, conflicts, metadata (rebuildable index)
      └── imara-diff            merge
```

**Rules (enforced by review, documented here per FND-09):**

1. `vault-core` must not depend on Tauri, React, or anything UI — it is buildable and
   testable headlessly (`cargo test -p vault-core`), which keeps mobile ports possible.
2. The UI never touches the filesystem or Git directly; every effect crosses
   `commands/` (Tauri dialog/opener plugins are the only exceptions).
3. Every command, DTO field, and error code is part of the UI contract — documented in
   `docs/api.md`; rename in lockstep or not at all.
4. Markdown files on disk are the source of truth; SQLite (`db.rs`) is a rebuildable
   index/journal, never a second copy of note contents.
5. Frontend shared helpers (`src/lib/*`) stay pure TypeScript — no Tauri `invoke` calls
   except `lib/ipc.ts`-style adapters and components that own their data loading.

## Build, quality gates, and CI

| Concern            | Command (repo root) | Notes                                        |
| ------------------ | ------------------- | -------------------------------------------- |
| Frontend dev       | `pnpm dev`          | Vite (md-app)                                |
| Typecheck          | `pnpm typecheck`    | `tsc --noEmit`                               |
| Lint / format      | `pnpm lint` / `pnpm format` | ESLint flat config + Prettier        |
| Frontend tests     | `pnpm test`         | Vitest in Chromium (Playwright)              |
| Frontend build     | `pnpm build`        | `tsc && vite build`                          |
| Rust format/lint   | `pnpm check:rust`   | `cargo fmt --check` + `clippy -D warnings`   |
| Rust tests         | `pnpm test:rust`    | workspace tests incl. crash-recovery suite   |
| Everything         | `pnpm verify`       | all of the above                             |

CI runs the same gates on `ubuntu-latest` (`.github/workflows/ci.yml`). Tauri's Linux
system prerequisites (GTK/WebKit) are needed to compile `md-app/src-tauri` locally on
Debian/Ubuntu; CI installs them via apt.

## Decision records

Architecture decisions live in `docs/adr/` (Git stack, sync model, and the in-process
sync-flow validation). Unresolved assumptions become spikes with written outcomes —
never silent folklore.
