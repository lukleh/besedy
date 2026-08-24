#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/.." && pwd)"
repo_root="${1:-$default_repo_root}"

production_inputs=(
  "web/src"
  "web/public"
  "web/messages"
  "web/package.json"
  "web/package-lock.json"
  "web/next.config.ts"
  "web/tsconfig.json"
  "web/postcss.config.mjs"
  "web/prisma.config.ts"
  "web/prisma/schema.prisma"
  "web/Dockerfile"
  "web/docker-compose.yml"
  "web/.dockerignore"
  "scripts/resolve_web_version.sh"
)

if ! git -C "$repo_root" rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "Cannot resolve a tracked repository in $repo_root" >&2
  exit 1
fi

# Production deploys must remain reproducible even when the dirty file would be
# excluded from the fingerprint (for example a test or local documentation).
dirty_sources="$(git -C "$repo_root" status --porcelain --untracked-files=normal -- web scripts/resolve_web_version.sh)"
if [[ -n "$dirty_sources" ]]; then
  echo "Cannot calculate a production web version from dirty web sources:" >&2
  printf '%s\n' "$dirty_sources" >&2
  exit 1
fi

tracked_inputs="$({
  for input in "${production_inputs[@]}"; do
    git -C "$repo_root" ls-tree -r --name-only HEAD -- "$input"
  done
} | LC_ALL=C sort -u)"

if [[ -z "$tracked_inputs" ]]; then
  echo "Cannot resolve tracked production web inputs in $repo_root" >&2
  exit 1
fi

fingerprint="$({
  while IFS= read -r path; do
    printf 'file:%s\0' "$path"
    git -C "$repo_root" show "HEAD:$path"
    printf '\0'
  done <<< "$tracked_inputs"

  # Only browser-visible/build-shaping values belong here. Never add secrets.
  printf 'config:APP_ENV\0%s\0' "${APP_ENV:-development}"
  printf 'config:NEXT_PUBLIC_APP_URL\0%s\0' "${NEXT_PUBLIC_APP_URL:-}"
  printf 'config:VAPID_PUBLIC_KEY\0%s\0' "${VAPID_PUBLIC_KEY:-}"
  printf 'config:NEXT_PUBLIC_SUPPORT_EMAIL\0%s\0' "${NEXT_PUBLIC_SUPPORT_EMAIL:-}"
  printf 'config:NEXT_PUBLIC_SUPPORT_EMAIL_B64\0%s\0' "${NEXT_PUBLIC_SUPPORT_EMAIL_B64:-}"
  printf 'config:OAUTH_MOCK_URL\0%s\0' "${OAUTH_MOCK_URL:-}"
} | sha256sum | cut -c1-40)"

printf 'web-v2-%s\n' "$fingerprint"
