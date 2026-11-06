# ADR: Auto-update (tauri-plugin-updater)

Date: 2026-11-06
Status: accepted
Scope: md-app desktop distribution (updater plugin + signing + release pipeline)

## Context

Releases ship as GitHub-release bundles (Windows MSI/NSIS, macOS universal
`.dmg`, Linux deb/rpm/AppImage) plus a pacman repo on Arch. Every new version
meant testers downloaded and reinstalled by hand. We want in-app auto-update:
check on startup, show a small "update available" card, download and restart.

Tauri v2's updater plugin supports Windows, macOS and Linux **AppImage**;
`.deb`/`.rpm` are explicitly unsupported. Update artifacts must be signed
(minisign) — the updater refuses unsigned bundles, so a keypair is required.

## Decision

1. **Platforms.** Windows and macOS get update manifests and in-app updates.
   Linux stays on the distro paths: deb/rpm via the existing pacman repo;
   the AppImage also gets signed updater artifacts (tauri creates
   `*.AppImage.sig` for free), so AppImage users can update in-app too.
2. **Signing.** One minisign keypair, no password:
   - public key committed in `tauri.conf.json` → `plugins.updater.pubkey`;
   - private key lives only in the GitHub Actions secret
     `TAURI_SIGNING_PRIVATE_KEY`, with a local backup at
     `~/.tauri/md-app.key` (machine owner's home). Losing it permanently
     orphans every installed copy — never commit it, back it up like a
     root cert.
   - `bundle.createUpdaterArtifacts: true` tells the bundler to emit `.sig`
     files; CI passes the secret through the `TAURI_SIGNING_PRIVATE_KEY` env.
3. **Manifests.** `release.yml` sets `includeUpdaterJson: true` so
   `tauri-action` uploads `latest.json` + the `.sig` files as release assets.
   The generated JSON's bundle URLs are tag-anchored
   (`…/releases/download/<tag>/…`).
4. **Endpoint.** Static GitHub manifest —
   `https://github.com/clickCA/md/releases/latest/download/latest.json`.
   GitHub's `/releases/latest` excludes pre-releases, so this resolves only
   once a **stable** release exists: all installed alpha/beta copies will
   jump straight to the first stable. Alpha→alpha is deliberately not served
   (testers reinstall from the tagged release, same as today).
5. **Client UX.** `useUpdate` (desktop-only guard, non-fatal on any failure)
   checks once at startup; a fixed bottom-right banner offers "Restart &
   update" / "Not now"; the command palette has "Check for updates". Relaunch
   goes through `@tauri-apps/plugin-process` (`relaunch`) because the core
   `@tauri-apps/api` has no process module. Capabilities: `updater:default`,
   `process:default`.
6. **Windows install mode** is `passive` (progress window, no interaction).

## Consequences

- The first stable `0.1.0` will auto-update every pre-release install.
- Pre-release updates are manual (reinstall from the tag) until a stable
  exists — accepted for the alpha phase.
- macOS bundles are unsigned (AGENTS.md), so auto-update there may be blocked
  by Gatekeeper until code signing + notarization land.
- A future beta/stable channel (dynamic endpoint, staged rollout, or hosting
  `latest.json` ourselves on the existing Pages infra to also serve
  pre-releases) is a clean follow-up: only the endpoint list changes.

## Out of scope (deliberate)

- macOS code signing / notarization.
- Beta channels, staged rollouts, differential (delta) updates.
- Android/iOS in-app updates (store-managed).
- Prompting before downloading; the banner install requires one explicit click.
