# AGENTS.md — working rules for coding agents (and humans) in this repo

`md` is a personal Markdown vault: Tauri 2 + React UI (`md-app/`) on a shared Rust
core (`crates/vault-core/`), plus an Astro landing page (`landing/`). Notes are
plain files; syncing is any standard git remote; conflicts become conflict-copies.

## Command map — `make` owns orchestration

- Every canonical invocation is a Makefile target. Do not invent parallel scripts;
  add/extend a target instead, and keep it in sync with CI (`.github/workflows/`).
- **Linux CI deps live in `docker/ci/Dockerfile`** (the `md-ci` builder image,
  rebuilt by `docker-ci.yml` on `main`) — the Rust job and the release Linux leg
  run inside it, so there is **no apt on the runner**. Add Linux packages there,
  never as a new apt step. Build it locally with `make docker-ci`.
  See `docs/adr/2026-11-06-ci-builder-image.md`.
- Canonical gates (what CI runs, what "done" means):

  | Gate | Target | Backend |
  | --- | --- | --- |
  | Lint | `make lint` | oxlint (JS/TSX) + `clippy --workspace --all-targets -- -D warnings` |
  | Format | `make format-check` | Prettier + `cargo fmt --check` |
  | Types | `make typecheck` | TypeScript 7 native `tsc --noEmit` |
  | Tests | `make test` | Vitest (browser) + `cargo test --workspace` |
  | Build | `make build` | `vite build` + `cargo build` |

- `make check` = all of the above. **A change is not done until `make check` is green.**
- JS: pnpm only, workspace filters (`pnpm --filter md-app …`). Rust: cargo directly
  (`make test-rust` etc. wrap it). Never add npm/yarn scripts.

## Language & code rules

### Rust (`crates/vault-core`, `md-app/src-tauri`)
- Edition 2024 (`md-app`) / workspace conventions in `Cargo.toml`; warnings are
  errors (`-D warnings`) — fix lints, don't `#[allow]` past them without a comment
  explaining why.
- Keep the engine UI-free: `vault-core` never imports Tauri/React concerns; UI ⇄
  core talks only through Tauri commands documented in `docs/api.md`.
- New engine behavior ships with tests in `crates/vault-core/tests/` (sync state
  machine changes: cover crash/kill convergence — see `kill_tests.rs`).
- Rustfmt is law (`cargo fmt`); keep `Cargo.lock` committed and consistent —
  `cargo tree -q >/dev/null` after any manifest edit.

### TypeScript / React (`md-app/src`)
- TypeScript 7 (native) for `tsc`; **oxlint** for linting (`.oxlintrc.json`) — do
  not reintroduce ESLint/typescript-eslint (TS 7 has no API for it; see commit
  `99048ff`).
- Formatting: Prettier, repo defaults (`make format-js`). Run it on touched files.
- React rules of hooks: errors. `exhaustive-deps` and `set-state-in-effect` are
  **warnings with a no-growth policy** — the existing occurrences are tracked UI
  debt (see `.oxlintrc.json`); never add new ones.
- Browser tests live next to components (`*.test.tsx`, Vitest browser mode on
  Playwright Chromium). Add tests for viewer/editor behavior changes.

### Landing (`landing/`)
- Astro + Tailwind; reuse tokens from `md-app`'s `theme.css` export — don't fork
  the design system. Rebuild `landing/dist` (`pnpm build:landing`) whenever
  `landing/src` changes; `dist` is committed on purpose.

## Git, branches, commits

- PRs into `main` only; CI must pass before merge. `main` is integration; the
  `release` branch is the shipping line (see `docs/RELEASING.md`).
- Commit style: `scope: imperative summary` — scope is the area (`md-app:`,
  `vault-core:`, `landing:`, `build:`, `packaging:`, `docs:`). One concern per
  commit; explain *why* in the body when it isn't obvious.
- Never commit: keystores/signing material (`*.jks`, `keystore.properties`),
  generated Android project (`src-tauri/gen/android`), or personal note content
  (`md-app/src/components/quire/vaultCorpus.generated.ts` — it's gitignored;
  keep it that way).

## Versioning & releases (read `docs/RELEASING.md` before shipping)

- **Artifacts carry numeric semver only** (`0.1.0`) — deb/rpm versions cannot
  contain the SemVer prerelease dash; the tauri bundler rejects it (burned us:
  run `42149401828` vs `41326369898`).
- Prerelease-ness lives in the tag (`v0.1.0-alpha.N`) + GitHub **Pre-release**
  flag + release title/landing copy. Never bump version strings per alpha.
- Release order: PRs → `main` → **Actions → "Promote to release"** (merges
  `main` → `release`) → cut tag from `release` **locally** (tag pushes made with
  `GITHUB_TOKEN` do not trigger workflows) → Release workflow builds Windows,
  macOS, Linux → then `make android` APK, `make pacman-publish`, landing button
  pointer.
- Never re-point a tag while its Release run is in flight — two runs race on
  asset uploads. Cancel the old run first.
- `release.yml` builds from `github.ref_name`, never from the app version; keep
  it that way.

## Platform-specific gotchas

- **Android**: `.cargo/config.toml` forces `-Wl,-z,max-page-size=16384` on every
  Android target — 4 KB-aligned `.so` files fail to load on 16 KB-page devices.
  Do not remove it. APKs are arm64 (`make android`); the local toolchain lives in
  `~/Android/env.sh` (source it before any `tauri android` command).
- **Windows/macOS bundles are unsigned** — installer UX notes belong in release
  notes; don't add fake signing config.
- **Landing + pacman repo** deploy from local `wrangler` (`wrangler login` once);
  `md-landing` and `md-repo` are separate Pages projects — don't mix their
  deploy directories.

## Dependencies & supply chain

- Bumps: `pnpm up --latest -r` + `cargo update`, then full `make check`.
- `pnpm-workspace.yaml` `minimumReleaseAgeExclude` pins exist on purpose
  (supply-chain hold-back on brand-new packages); don't delete entries casually.
- TypeScript stays on the native `typescript` package (7.x). If a tool claims it
  needs the TS 6 API, the answer is oxlint/no-tool, not the compat package.

## Docs duty

Decisions get an ADR (`docs/adr/`); contract changes update `docs/api.md`;
architecture changes update `docs/ARCHITECTURE.md`; shipping changes update
`docs/RELEASING.md`. A PR that changes behavior without touching docs is
incomplete.
