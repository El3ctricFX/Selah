#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <version>"
  exit 1
fi

V="v$1"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty. commit and push first."
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "error: local main is not in sync with origin/main."
  echo "  local:  $LOCAL"
  echo "  remote: $REMOTE"
  echo "Push first, then run this script."
  exit 1
fi

if git rev-parse "$V" >/dev/null 2>&1; then
  echo "error: tag $V already exists locally."
  exit 1
fi

if git ls-remote --tags origin "$V" | grep -q "$V"; then
  echo "error: tag $V already exists on origin."
  exit 1
fi

git tag "$V"
git push origin "$V"
echo
echo "Tag $V pushed. CI should start in a few seconds."
echo "Watch: https://github.com/El3ctricFX/Selah/actions"