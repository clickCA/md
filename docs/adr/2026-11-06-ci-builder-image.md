# ADR: Linux CI runs inside a baked builder image (no apt on the runner)

Date: 2026-11-06
Status: accepted
Scope: CI/build infra (docker/ci/, .github/workflows/docker-ci.yml, ci.yml, release.yml)

## Context

Every Linux CI run had to install Tauri v2's system prerequisites before it
could compile `md-app/src-tauri`:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
  build-essential curl wget file
```

That block was copy-pasted into `ci.yml` (Rust job) and `release.yml`
(Linux matrix leg). Two problems:

1. `apt-get update` + install re-ran on every workflow run — slow, and it makes
   the build's success depend on the apt mirrors being reachable at run time.
2. Two sources of truth for "what the Linux build needs" drift apart.

## Options considered

- **Keep apt on the hosted runner, dedupe into a composite action.** Removes
  the copy-paste but still does the apt dance every run; doesn't address the
  user's concern.
- **Base image baked with the deps** (chosen). The Linux legs run inside a
  container image that already has everything, so per-run CI only pulls the
  image.
- GitHub's own `tauri-action` publishes no container image, and `ubuntu-latest`
  does not ship WebKitGTK dev headers — building our own image is the only way
  to get "deps preinstalled" for Tauri.

## Decision

1. **`docker/ci/Dockerfile`** — based on `ubuntu:24.04`, the same base the
   `ubuntu-latest` runner uses, so the glibc baseline of released artifacts is
   identical to what hosted CI produced before (Tauri guidance: build on the
   oldest base you still support). It installs the identical package list the
   workflows used to apt-get, plus `patchelf`/`rpm`/`libfuse2t64` that a bare
   Ubuntu image lacks but the runner image already shipped (needed for
   AppImage/RPM bundling).
2. **`.github/workflows/docker-ci.yml`** builds the image once and pushes
   `ghcr.io/clickca/md-ci:latest` (+ `:sha-…`). Triggered on `main` when
   `docker/**` or the workflow changes, plus `workflow_dispatch` for manual
   rebuilds.
3. **`ci.yml` (Rust job) and `release.yml` (Linux matrix leg)** run inside that
   container (`container:`), dropping the per-run apt step. macOS/Windows
   release legs stay on the host runner (`container: null`, GitHub's supported
   opt-out).
4. **`make docker-ci`** builds the image locally for verification without
   touching CI.
5. **Rust toolchain baked into the image** (added 2026-11-12): rustup installs
   the exact channel `rust-toolchain.toml` pins (1.99.1) with rustfmt + clippy,
   under `/usr/local/{rustup,cargo}`. The workflows' `dtolnay/rust-toolchain`
   steps stay and become fast no-ops; a channel bump touches the Dockerfile,
   `rust-toolchain.toml` and the `dtolnay/rust-toolchain` ref in one commit.

GHCR image references are lowercase by requirement (`clickca`), regardless of
the GitHub owner's display case (`clickCA`).

## Consequences

- Per-run Linux CI no longer runs `apt-get update`; it pulls a cached image
  (BuildKit GHCR cache) instead. Fallbacks: trivially revertible — keep the
  image, remove the `container:` block, and CI returns to apt.
- Deps now change in exactly one place: edit `docker/ci/Dockerfile`, pushes to
  `main` rebuild the image. A PR that changes the Dockerfile can't be CI-verified
  against the new deps until merged (the image is rebuilt from `main`), which is
  acceptable for this repository's cadence.
- The image pins no package versions — rebuilds are effectively `latest` of that
  Ubuntu release, so like the old `apt-get`-on-run path they get upstream
  security fixes whenever the image is rebuilt.
- `container: ${{ matrix.container }}` relies on `container: null` being GitHub's
  documented way to run a matrix combo on the host; if that ever changes, the
  release workflow's Linux leg alone pins the image.
- Private-repo pull of the package is authenticated via `container.credentials`
  using the workflow `GITHUB_TOKEN`.
- The baked Rust toolchain re-downloads nothing per CI run, but it is one more
  pin to keep in sync (Dockerfile ↔ `rust-toolchain.toml` ↔ action ref).

## Out of scope

- Bumping the Ubuntu base (would change the runtime glibc baseline; revisit
  deliberately per Tauri's Linux/glibc guidance).
- Cross-compiling an ARM Linux build (follow-up; would extend the image with
  cross targets).
