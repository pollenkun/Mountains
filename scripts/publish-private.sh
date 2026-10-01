#!/usr/bin/env bash
set -euo pipefail

# Run manually only after reviewing the complete local repository and deciding
# the public author identity. This script creates a PRIVATE GitHub repository.
# Usage: bash scripts/publish-private.sh YOUR_GITHUB_ACCOUNT mountains --execute
owner="${1:-}"
repo="${2:-mountains}"
if [[ -z "$owner" || "${3:-}" != "--execute" ]]; then
  echo "Usage: bash scripts/publish-private.sh YOUR_GITHUB_ACCOUNT mountains --execute" >&2
  exit 2
fi
if [[ ! "$owner" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ || ! "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid account or repository name." >&2
  exit 2
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
command -v gh >/dev/null
command -v git >/dev/null
if [[ -n "$(git remote)" || -n "$(git status --porcelain)" ]]; then
  echo "Expected a clean repository with no configured remotes." >&2
  exit 1
fi
if [[ "$(git rev-list --count HEAD)" != "1" ]]; then
  echo "Expected exactly one reviewed initial commit." >&2
  exit 1
fi
gh auth status --hostname github.com
gh repo create "$owner/$repo" --private --source "$root" --remote origin \
  --description "A cache-aware coding agent engine and CLI for DeepSeek, GLM, and Kimi."
git push --set-upstream origin main
gh repo edit "$owner/$repo" --add-topic coding-agent --add-topic typescript \
  --add-topic deepseek --add-topic glm --add-topic kimi --add-topic prompt-caching
printf 'Private repository prepared: https://github.com/%s/%s\n' "$owner" "$repo"
