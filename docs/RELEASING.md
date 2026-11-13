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
5. **Android APK** — the Release workflow builds and attaches it as
   `md-app-android-arm64.apk`. It is gated on the repo variable
   `ANDROID_RELEASE_ENABLED` (a job-level `if` — secrets are not readable
   there), so a release without the signing secrets just skips the job:
   ```bash
   gh variable set ANDROID_RELEASE_ENABLED --body true   # after the secrets exist
   ```
   Secrets (repository → Settings → Secrets → Actions):

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | `base64 -w0 ~/.android/upload-keystore.jks` |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore password |
   | `ANDROID_KEY_ALIAS` | `upload` |
   | `ANDROID_KEY_PASSWORD` | key password |

   CI runs `tauri android init --ci` (because `gen/android` is gitignored),
   writes `keystore.properties` from the secrets, then runs `make android` —
   the same signed **release** build used locally. Keep the job's
   `NDK_VERSION` in sync with `~/Android/env.sh`.

   Manual fallback from the same commit: `make android` (needs
   `~/Android/env.sh` and the gitignored
   `md-app/src-tauri/gen/android/keystore.properties`), then upload the
   `app-universal-release.apk` from
   `md-app/src-tauri/gen/android/app/build/outputs/apk/universal/release/`
   to the release as `md-app-android-arm64.apk`. Do **not** use
   `ANDROID_BUILD_FLAGS=--debug` for a shipped artifact — that produces a
   debuggable, cleartext-allowed APK signed with the local debug key.
6. **Distribution surfaces publish themselves** — `publish-distributions.yml`
   runs on the same tag push and covers both, once enabled:
   ```bash
   gh variable set DISTRIBUTION_PUBLISH_ENABLED --body true   # after the secrets exist
   ```
   Secrets:

   | Secret | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Cloudflare API token, **Pages: Edit** on `md-landing` + `md-repo` |
   | `RELEASE_PAT` | fine-grained PAT on `clickCA/md` — **Contents** and **Pull requests: read & write** (PRs opened with `GITHUB_TOKEN` don't trigger CI, so their required checks would never start) |

   - **Landing**: bumps `Footer.astro` to the tag, rebuilds `landing/dist`,
     deploys `md-landing`, and opens an auto-merging bump PR (so the committed
     `dist` matches what the Pages project serves).
   - **Pacman**: waits for the `.deb`, then runs
     `packaging/arch/publish.sh` (rebuild + `repo-add` + deploy `md-repo` in an
     Arch container) and opens an auto-merging `PKGBUILD` bump PR.
   - If `main` has moved past the tag before a bump PR runs, auto-merge
     refuses and the PR waits for a human — nothing stale ships silently.

   Manual fallback (also what to do for a one-off fix): `pnpm build:landing` +
   `wrangler pages deploy landing/dist --project-name md-landing --branch main`
   for the button, and **`make pacman-publish`** for the pacman repo (needs
   `gh`, `makepkg`, `repo-add`, and a `wrangler login`); publish.sh commits the
   `packaging/arch/PKGBUILD` bump to `main` when run there directly.

## Version convention

- **Artifacts carry numeric semver** (`0.1.0`) — deb/rpm versions cannot
  contain the SemVer prerelease dash; the tauri bundler rejects it.
- **Prerelease-ness lives outside the version**: tag suffix
  (`v0.1.0-alpha.N`), GitHub Pre-release flag, release title, landing copy.
- Version strings change only for real releases (`0.1.0` → `0.2.0`), never
  per alpha/beta iteration.

## Auto-update (tauri-plugin-updater)

- **Covers**: Windows (NSIS/MSI) and macOS update in-app; Linux deb/rpm keep
  going through the pacman repo (`make pacman-publish`); the Linux AppImage
  also gets a signed updater artifact for free.
- **The workflow does the work**: `bundle.createUpdaterArtifacts: true` +
  `includeUpdaterJson: true` make the Release build upload `latest.json` and
  the `.sig` files to the tag's release. No manual manifest handling.
- **Signing keys**: the private key is the GitHub Actions secret
  `TAURI_SIGNING_PRIVATE_KEY`; its local backup lives at `~/.tauri/md-app.key`.
  The matching public key is committed in `tauri.conf.json`
  (`plugins.updater.pubkey`). **Losing the private key means you can never
  ship an update again** — treat the backup like a root cert.
  - Locked future releases to a *new* key: generate a fresh keypair, replace
    the pubkey in `tauri.conf.json`, update the secret, and cut one
    "re-key" update signed by the old key that instructs users to reinstall.
- **Endpoint**: the app checks
  `https://github.com/clickCA/md/releases/latest/download/latest.json`.
  GitHub's `/releases/latest` excludes pre-releases, so alpha installs first
  auto-update when a **stable** `0.1.0` lands; alpha→alpha stays manual
  (reinstall from the tag). See `docs/adr/2026-11-06-auto-update.md`.
- **Re-keying / channel caveats, macOS signing** — see the ADR.
