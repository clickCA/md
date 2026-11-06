# Releasing

`main` is integration; `release` is what ships.

## Flow

1. **Land work on `main`** — PRs only, CI gates every change.
2. **Promote** — Actions tab → *Promote to release* → *Run workflow* (or
   `gh workflow run promote-release.yml`). It merges `main` → `release`
   (fast-forward when possible, merge commit otherwise).
3. **Cut a tag from the release branch** — locally, because tag pushes made
   with `GITHUB_TOKEN` do not trigger other workflows (GitHub's recursion
   guard):
   ```bash
   git fetch origin
   git tag v0.1.0-alpha.3 origin/release
   git push origin v0.1.0-alpha.3
   ```
4. **The Release workflow builds everything** — Windows (MSI/NSIS), macOS
   (universal `.dmg`), Linux (deb/rpm/AppImage) — and attaches them to a
   GitHub **Pre-release** named after the tag. Linux builds run inside the
   `md-ci` builder image (deps baked in — see `docker/ci/Dockerfile` and
   ADR 2026-11-06); if a Linux toolchain/dep bump is needed, change that
   Dockerfile, merge, and CI rebuilds the image automatically.
5. **Android APK** — built locally from the same commit: `make android`,
   then upload to the release as `md-app-android-arm64.apk`.
6. **Point the distribution surfaces at the new tag**:
   - landing button: `landing/src/components/Footer.astro` → rebuild → deploy
     (`pnpm build:landing` + `wrangler pages deploy landing/dist`)
   - pacman repo: **`make pacman-publish`** — downloads the fresh `.deb` from
     the release, rebuilds the package, `repo-add`, and deploys `md-repo`
     (needs `gh`, `makepkg`, `repo-add`, and a `wrangler login`); it commits the
     `packaging/arch/PKGBUILD` bump to `main` when run there

## Version convention

- **Artifacts carry numeric semver** (`0.1.0`) — deb/rpm versions cannot
  contain the SemVer prerelease dash; the tauri bundler rejects it.
- **Prerelease-ness lives outside the version**: tag suffix
  (`v0.1.0-alpha.N`), GitHub Pre-release flag, release title, landing copy.
- Version strings change only for real releases (`0.1.0` → `0.2.0`), never
  per alpha/beta iteration.
