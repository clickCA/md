#!/usr/bin/env bash
# Refresh the pacman repo (https://md-repo.pages.dev) from a GitHub release.
#
# Usage:
#   packaging/arch/publish.sh [tag] [pkgrel]
#     tag    defaults to the most recent release
#     pkgrel defaults to (number of releases + 1) — the Arch revision
#
# Requires: gh (authenticated), makepkg + repo-add (pacman), and a
# wrangler login (`wrangler login` — deploys to the md-repo Pages project).
# Keep this step in the release checklist: docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")"

REPO_SLUG=clickCA/md

TAG=${1:-$(gh release list --repo "$REPO_SLUG" --limit 1 --json tagName -q '.[0].tagName')}
PKGREL=${2:-$(($(gh release list --repo "$REPO_SLUG" --limit 30 --json tagName -q 'length') + 1))}
echo "==> publishing $TAG as md-app 0.1.0-$PKGREL"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh release download --repo "$REPO_SLUG" "$TAG" --pattern 'md-app_*_amd64.deb' --dir "$work" --clobber
deb=$(ls "$work"/md-app_*_amd64.deb)
sha=$(sha256sum "$deb" | cut -d' ' -f1)

cp PKGBUILD "$work/PKGBUILD"
sed -i \
  -e "s/^pkgrel=.*/pkgrel=$PKGREL/" \
  -e "s/^_tag=.*/_tag=$TAG/" \
  -e "s/^sha256sums=(.*/sha256sums=('$sha')/" \
  "$work/PKGBUILD"
grep -E '^(pkgrel|_tag|sha256)' "$work/PKGBUILD"

( cd "$work" && makepkg -f >/dev/null && repo-add md.db.tar.gz "md-app-0.1.0-$PKGREL-x86_64.pkg.tar.zst" )

repo=$(mktemp -d)
mkdir -p "$repo/os/x86_64"
cp "$work/md-app-0.1.0-$PKGREL-x86_64.pkg.tar.zst" "$work/md.db" "$repo/os/x86_64/"

if command -v wrangler >/dev/null 2>&1; then
  wrangler pages deploy "$repo" --project-name md-repo --branch main | grep -E "Deployment complete"
else
  pnpm dlx wrangler pages deploy "$repo" --project-name md-repo --branch main | grep -E "Deployment complete"
fi

# keep the in-repo PKGBUILD in sync with what the repo serves
cp "$work/PKGBUILD" PKGBUILD
if [[ $(git branch --show-current 2>/dev/null) == main && -n $(git status --porcelain PKGBUILD) ]]; then
  git add PKGBUILD
  git commit -m "packaging: pacman repo serves 0.1.0-$PKGREL from $TAG"
  git push origin main
elif [[ -z $(git status --porcelain PKGBUILD 2>/dev/null) ]]; then
  echo "PKGBUILD unchanged (already serving this build)"
else
  echo "PKGBUILD updated — commit & push it when back on main"
fi
