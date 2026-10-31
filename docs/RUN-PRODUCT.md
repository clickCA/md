# Running Quire — from patch to product

Everything you need to apply the patch series, start the app, and exercise
every feature. Time from zero to running app: ~10 minutes (plus one-time
toolchain setup).

## 1. Prerequisites

| Tool    | Version            | Check                |
| ------- | ------------------ | -------------------- |
| Node    | ≥ 22               | `node --version`     |
| pnpm    | 9 or 12            | `pnpm --version`     |
| Rust    | 1.94 (pinned)      | `rustc --version`    |
| GNU make| any 4.x            | `make --version`     |
| git     | ≥ 2.30             | `git --version`      |

Rust is installed via [rustup](https://rustup.rs) — the repo's
`rust-toolchain.toml` pins 1.94.0 and rustup fetches it automatically on the
first build. Linux desktop builds additionally need the Tauri system
packages (Debian/Ubuntu):

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential
```

macOS needs nothing extra (Xcode CLT). Windows needs WebView2 (preinstalled
on Win11) + MSVC Build Tools.

## 2. Apply the patch series

```bash
git clone https://github.com/clickCA/md && cd md
git checkout -b feat/image-viewer main
git am /path/to/quire-patch/0001-*.patch \
       /path/to/quire-patch/0002-*.patch \
       /path/to/quire-patch/0003-*.patch \
       /path/to/quire-patch/0004-*.patch \
       /path/to/quire-patch/0005-*.patch
```

(Or squash everything instead: `git apply quire-all-in-one.diff`, commit once.)

## 3. Build and run

```bash
make setup      # pnpm install + cargo fetch
make check      # full gate: lint, format, typecheck, 34 frontend tests,
                # 18 Rust tests, frontend build, Rust build — should all pass
make dev        # → the Quire window opens (Tauri + Vite hot reload)
```

That's the product. For a distributable binary:

```bash
pnpm --filter md-app tauri build    # installer/bundle under md-app/src-tauri/target/release/bundle/
```

## 4. First run — what you will see

1. **Vault picker** (empty start). Click *Choose folder* → pick or create an
   empty folder → Quire offers one-step setup: it `git init`s the folder,
   creates the SQLite journal, and opens the workspace. Optionally paste a
   Git remote URL now, or later in Vault settings.
2. **Workspace**: left sidebar (files · search · source control tabs), center
   live editor, right inspector (word count, reading time, heading outline).

### The 60-second feature tour

| Do this                                                | What happens                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `Ctrl N`, type a title, write Markdown                  | Live preview follows you; autosaves 700 ms after you stop typing    |
| Paste an image into a note                              | Saved into the vault, rendered inline; click it → zoom/pan/rotate viewer |
| `Ctrl K` (or sidebar → search)                          | Full-text search (FTS5), relevance-ranked, click a hit to jump to the line |
| Sidebar → source control                                | Local-ahead/remote-ahead status, recent sync journal, push/pull/sync buttons |
| Set a remote + edit for ~5 s                            | Auto-sync fires by itself; failures show quietly inside the panel   |
| Edit the same note on another clone, sync both          | Non-overlapping edits merge; overlapping edits keep both (`.conflict-<ts>.md`) |
| Open the same folder in any other editor                | Plain Markdown + plain Git — everything keeps working; Quire's search picks up the change on its next query |
| Vault settings (gear)                                   | Remote URL, auto-sync toggle, theme switch                          |

## 5. Where the data lives

```
<vault>/            ← YOUR data: *.md files + images, plain files
<vault>/.git/       ← history, owned by real Git
<vault>/index.db    ← rebuildable index (search + sync journal); delete anytime
```

The vault is portable: copy it, clone it, push it to any Git host. If Quire
disappeared tomorrow, you'd lose nothing but the app.

## 6. Troubleshooting

| Symptom                                      | Fix                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `webkit2gtk-4.1 ... not found` on Linux       | Install the Tauri packages from §1                                     |
| `make check` fails on clippy in CI but not locally | `rustup component add rustfmt clippy` — CI pins the same toolchain |
| Browser tests skip/fail                       | `pnpm --filter md-app exec playwright install chromium`                |
| Sync asks for credentials repeatedly          | Use the credentials dialog once per session; tokens stay in memory      |
| Search index feels stale after bulk import    | It isn't — the next query stats the files and rebuilds. If you want to force it: delete `<vault>/index.db` |
| Windows path errors opening a vault           | Keep vaults off network drives; sync indices dislike SMB latency       |

## 7. What is not in this build

- **Mobile (Android/iOS)**: the core engine is shared Rust and the gix/git2
  stack is chosen for mobile portability, but no mobile targets ship in this
  series — that is the MOB epic, gated on device testing.
- **Auto-resolution of conflicts**: by design. Auto-sync will happily sync
  conflicts into being, but resolving them stays a human decision.
- **Cloud service, realtime collaboration, AI, plugins**: excluded from the
  product boundary on purpose.
