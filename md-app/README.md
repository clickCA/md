# md-app — Tauri 2 + React + TypeScript

Desktop (and future mobile) shell for the `md` vault. The UI is thin: all vault,
sync, and conflict logic lives in `crates/vault-core`; this crate only exposes it
as Tauri commands.

## Prerequisites

- Rust 1.94 (workspace toolchain pin), pnpm 12
- Linux: `webkit2gtk-4.1` and `libgit2` dev packages
- macOS: Xcode CLT (no extra packages needed)

## Commands

```
pnpm install
pnpm tauri dev        # dev with hot reload (vite on :1420)
pnpm build            # frontend only
```

Self-contained release binary (frontend embedded, no dev server):

```
cargo build --release -p md-app   # from the repo root → target/release/md-app
```

> A **debug** build run without the dev server shows "could not connect to
> localhost:1420" — debug builds load `devUrl`. Use `pnpm tauri dev` or the
> release binary.

## Using the app

1. **Init w/ remote** — creates the vault directory and points it at a bare Git
   repo (any path or standard remote)
2. Edit the note in the textarea, **Save note**
3. **Sync** — commits pending changes, fetches, merges (auto or LWW with
   conflict copies), pushes; the status panel shows head/remote oids, the
   journal trail (`fetching → merging → committing → pushing`), and any
   conflict report

## Tauri commands (src-tauri/src/lib.rs)

| Command                                 | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `vault_init(dir, remoteUrl)`            | create vault + remote binding                                   |
| `vault_open(dir)` / `vault_status(dir)` | status DTO: head, remote, pending, conflicts, last journal run  |
| `vault_sync(dir)`                       | full sync cycle → action + conflicts                            |
| `note_read / note_write / note_delete`  | note CRUD                                                       |
| `vault_path(dir, path)`                 | absolute path of a vault-relative file (reveal in file manager) |

## Mobile (next milestone)

- `pnpm tauri android init` / `pnpm tauri ios init`
- Cross-compilation needs **vendored libgit2** (enable the `git2/vendored`
  feature for mobile targets; requires cmake in the NDK/Xcode toolchain)
- Sync triggers: on launch and foregrounding first; background windows are
  opportunistic only (iOS/Android do not guarantee background execution)

## IDE

[VS Code](https://code.visualstudio.com/) +
[Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
