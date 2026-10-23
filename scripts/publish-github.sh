#!/usr/bin/env bash
set -euo pipefail

# Run only when you want to create a GitHub repository and push this starter.
# Default visibility is private. Set VISIBILITY=public explicitly if desired.
OWNER="${OWNER:-hangndat}"
REPO="${REPO:-orca-task-telemetry}"
VISIBILITY="${VISIBILITY:-private}"

if [[ "$VISIBILITY" != private && "$VISIBILITY" != public ]]; then
  echo "VISIBILITY must be private or public" >&2; exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install it and run 'gh auth login'." >&2; exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Git is required." >&2; exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
expected_root="$(pwd -P)"
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  current_root="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
  if [[ "$current_root" != "$expected_root" ]]; then
    echo "This folder is nested inside another Git repository. Refusing to publish." >&2
    exit 1
  fi
else
  git init -b main
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "origin already exists. Refusing to overwrite it." >&2; exit 1
fi

gh auth status
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git add .
  git commit -m "chore: scaffold reusable telemetry CLI"
fi

gh repo create "$OWNER/$REPO" "--$VISIBILITY" --source=. --remote=origin --push
