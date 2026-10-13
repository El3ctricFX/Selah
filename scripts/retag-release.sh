#!/usr/bin/env bash
# Deletes a release tag locally AND on GitHub, then re-runs
# tag-release.sh to create and push it fresh. Use this when CI
# failed against a tag and you need to retry with the same
# version number, or when you tagged the wrong commit.
#
# Usage:
#   ./scripts/retag-release.sh            (prompts for version)
#   ./scripts/retag-release.sh 0.1.6      (non-interactive)

set -euo pipefail

# ── Version: arg or prompt ─────────────────────────────────────────────
if [ $# -ge 1 ]; then
  VERSION="$1"
else
  read -r -p "Version to retag (e.g. 0.1.6): " VERSION
fi

# Trim a leading "v" if the user typed it, since tag-release.sh expects
# a bare version and adds the "v" prefix itself.
VERSION="${VERSION#v}"

if [ -z "$VERSION" ]; then
  echo "error: no version provided."
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version must look like X.Y.Z (got: $VERSION)"
  exit 1
fi

TAG="v$VERSION"

# Make sure we're at the repo root.
if [ ! -f package.json ] || [ ! -d src-tauri ]; then
  echo "error: run this from the repo root"
  exit 1
fi

# Make sure we're in a git repo with a remote named origin.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not inside a git repository."
  exit 1
fi

echo
echo "This will:"
echo "  1. Delete tag $TAG locally (if it exists)"
echo "  2. Delete tag $TAG on origin (if it exists)"
echo "  3. Run ./scripts/tag-release.sh $VERSION to recreate and push it"
echo
read -r -p "Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# ── 1. Delete local tag ────────────────────────────────────────────────
if git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -d "$TAG"
  echo "  ✓ deleted local tag $TAG"
else
  echo "  · no local tag $TAG (nothing to delete)"
fi

# ── 2. Delete remote tag ───────────────────────────────────────────────
# git ls-remote --tags prints lines like "<sha>\trefs/tags/v0.1.6".
# Grep for the exact ref so we don't accidentally match a substring.
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG$"; then
  git push --delete origin "$TAG"
  echo "  ✓ deleted remote tag $TAG"
else
  echo "  · no remote tag $TAG (nothing to delete)"
fi

# ── 3. Hand off to the existing tag-release script ────────────────────
if [ ! -x "./scripts/tag-release.sh" ]; then
  echo
  echo "error: ./scripts/tag-release.sh is missing or not executable."
  echo "Run: chmod +x ./scripts/tag-release.sh"
  exit 1
fi

echo
echo "Re-creating and pushing $TAG…"
echo
exec ./scripts/tag-release.sh "$VERSION"