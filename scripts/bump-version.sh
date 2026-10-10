#!/usr/bin/env bash
# Bumps the version across every file that needs it.
#
# Usage:
#   ./scripts/bump-version.sh 0.1.2
#
# Files updated:
#   - package.json
#   - package-lock.json
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
#   - flatpak/io.github.el3ctricfx.selah.yml  (deb filename, appears twice)
#
# After running, review the changes in GitHub Desktop, commit, push,
# then create your tag.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <version>"
  echo "example: $0 0.1.2"
  exit 1
fi

NEW="$1"

# Validate semver-ish (X.Y.Z, optionally with a -prerelease suffix)
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version must look like X.Y.Z (got: $NEW)"
  exit 1
fi

# Make sure we're at the repo root
if [ ! -f package.json ] || [ ! -d src-tauri ]; then
  echo "error: run this from the repo root"
  exit 1
fi

OLD=$(grep -m1 '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
echo "Bumping $OLD -> $NEW"
echo

# 1. package.json + package-lock.json (npm handles both)
npm version "$NEW" --no-git-tag-version --allow-same-version > /dev/null
echo "  ✓ package.json"
echo "  ✓ package-lock.json"

# 2. src-tauri/tauri.conf.json
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$NEW\"/" src-tauri/tauri.conf.json
echo "  ✓ src-tauri/tauri.conf.json"

# 3. src-tauri/Cargo.toml — only the first `version = "..."` line
sed -i "0,/^version = \".*\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml
echo "  ✓ src-tauri/Cargo.toml"

# 4. flatpak manifest — both selah_X.Y.Z_amd64.deb references
sed -i "s/selah_[0-9][0-9.]*_amd64\.deb/selah_${NEW}_amd64.deb/g" \
  flatpak/io.github.el3ctricfx.selah.yml
echo "  ✓ flatpak/io.github.el3ctricfx.selah.yml (2 lines)"

echo
echo "Verify with:"
echo "  grep '\"version\"' package.json"
echo "  grep '\"version\"' src-tauri/tauri.conf.json"
echo "  grep '^version' src-tauri/Cargo.toml"
echo "  grep 'selah_.*deb' flatpak/io.github.el3ctricfx.selah.yml"
echo
echo "Then: commit + push in GitHub Desktop, create tag v$NEW."