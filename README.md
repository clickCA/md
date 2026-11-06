# md

Personal Markdown vault with a Git-backed sync engine. Target: one portable vault on
macOS, Linux, iOS/iPadOS, and Android — Tauri 2 + React UI on a shared Rust core.

Plain `.md` files on disk, a standard git remote for syncing, conflicts preserved as
files — no lock-in, no proprietary format, no database of record.

## Download & install

Prebuilt builds live at
[github.com/clickCA/md/releases](https://github.com/clickCA/md/releases) (tagged
`v0.1.0-alpha.N` and flagged **Pre-release**). The download button on
[md-landing.pages.dev](https://md-landing.pages.dev) always points at the current one.

| Platform | Artifact | Notes |
| -------- | -------- | ----- |
| Windows x64 | `*-setup.exe` / `.msi` | unsigned — SmartScreen: *More info → Run anyway* |
| macOS (Apple Silicon + Intel) | `*_universal.dmg` | unsigned — right-click → **Open** on first launch |
| Debian / Ubuntu | `.deb` | `sudo apt install ./md-app_*_amd64.deb` |
| Fedora / openSUSE | `.rpm` | `sudo dnf install ./md-app-*.x86_64.rpm` |
| Any Linux | `.AppImage` | `chmod +x` and run |
| Android (arm64) | `.apk` | sideload; Android 7.0+ |

### Arch Linux (pacman repo)

```bash
sudo tee -a /etc/pacman.conf <<'EOF'

[md]
Server = https://md-repo.pages.dev/os/x86_64
SigLevel = Optional TrustAll
EOF

sudo pacman -Syu md-app
```

`pacman -Syu` picks up new versions as releases land.

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
- **Path exclusions**: a `.quireignore` file at the vault root hides notes
  from the app (file tree, note listing, search, AI) without touching git —
  excluded notes stay on disk, tracked, and synced. Same habits as
  `.gitignore`: folders, globs, `!` re-include; the file itself syncs, so
  rules follow the vault across devices

## Status

| Milestone | State |
| --------- | ----- |
| Sync spike: engine + merge + crash recovery, desktop test suite | ✅ done |
| Transport decision: hybrid gix + libgit2 push | ✅ done |
| Tauri 2 desktop app wired to the core | ✅ done |
| Editor UX, search index, image viewer, background scheduling | ✅ done |
| Alpha shipping: Android + Windows + macOS + Linux | ✅ `v0.1.0-alpha.N` |
| iOS / iPadOS | ⬜ next |
| Signed installers + auto-updates | ⬜ backlog |

Full design + gitoxide evaluation log:
[docs/adr/2026-10-12-git.md](docs/adr/2026-10-12-git.md)

## Release flow

`main` is integration; the `release` branch is what ships:

1. merge PRs to `main` (CI gates everything)
2. **Actions → "Promote to release"** (manual dispatch) merges `main` → `release`
3. cut a tag from the release branch — CI then builds Windows, macOS, and Linux
   bundles and attaches them to a GitHub Pre-release
4. finish the per-platform bits (Android APK, pacman repo, landing link) per
   [docs/RELEASING.md](docs/RELEASING.md) — `make pacman-publish` refreshes the
   Arch repo in one command

Artifacts carry numeric semver (`0.1.0`); prerelease-ness is the tag suffix
(`v0.1.0-alpha.N`) plus the GitHub Pre-release flag.

## Commands

One entry point from the repo root — `make` orchestrates across ecosystems;
each ecosystem keeps its native tooling (pnpm owns JS scripts, cargo owns
Rust invocations, and neither duplicates the other):

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `make setup`        | Install dependencies (pnpm + cargo fetch) |
| `make dev`          | Run the desktop app (Tauri + Vite)        |
| `make lint`         | oxlint + clippy (warnings are errors)     |
| `make format-check` | Verify Prettier + rustfmt formatting      |
| `make typecheck`    | TypeScript 7, no emit                     |
| `make test`         | Vitest + cargo test over both workspaces  |
| `make build`        | Frontend build + Rust workspace compile   |
| `make check`        | Full verification suite (mirrors CI)      |
| `make android`      | Debug APK (arm64) — needs `~/Android/env.sh` |
| `make android-log`  | Follow logcat for the installed app       |
| `make pacman-publish` | Refresh the Arch pacman repo from the latest release |
| `make clean`        | Remove build artifacts                    |

Granular targets: `lint-js` / `lint-rust`, `test-js` / `test-rust`,
`format-js` / `format-rust` (plus `-check` variants), `build-js` / `build-rust`,
`build-landing`, `dev-landing`. Run `make` with no arguments to list them.

## Test suite

```
make test-rust      # 19 tests: happy path, concurrent edits, delete-vs-edit,
                    # offline-then-online, nested dirs, line-merge units,
                    # SIGKILL convergence at every sync state
make test-js        # frontend suite (Vitest browser tests)
make check          # every quality gate in one shot
```

Quality gates and layout are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the UI ⇄ Rust command contract is
[docs/api.md](docs/api.md); the shipping checklist is
[docs/RELEASING.md](docs/RELEASING.md).

## Toolchain

- Rust 1.99.1 (pinned in `rust-toolchain.toml`)
- pnpm 12 (frontend), Node ≥ 26, GNU make (developer entry point)
- TypeScript 7 (native `tsc`); oxlint for JS/TSX linting
- Linux build deps: webkit2gtk-4.1, libgit2 ≥ 1.9 (mobile builds vendor libgit2 via cmake)
