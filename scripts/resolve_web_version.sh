#!/usr/bin/env bash

set -euo pipefail

# Production-relevant paths whose tracked content (plus a few build-shaping
# env values below) determine the web-v2-<hash> fingerprint. Keep this in
# sync with what actually ends up in the production web image.
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
  "web/docker-compose.production.yml"
  "web/.dockerignore"
  "scripts/resolve_web_version.sh"
)

# Computes the web-v2-<hash> fingerprint for an arbitrary commit-ish without
# requiring a checkout, so callers can recompute it for historical commits
# (see resolve_web_version_history.sh). Only browser-visible/build-shaping
# env values belong in the hash below. Never add secrets.
web_version_fingerprint() {
  local repo_root="$1" commit="$2"

  local tracked_input_bytes
  tracked_input_bytes="$(
    git -C "$repo_root" ls-tree -r -z --full-tree "$commit" -- "${production_inputs[@]}" \
      | wc -c
  )"
  if (( tracked_input_bytes == 0 )); then
    return 1
  fi

  {
    # Hash Git's NUL-delimited tree entries directly. Each entry includes the
    # exact path bytes, file mode, object type, and blob ID, so filenames
    # that Git would quote for display (for example non-ASCII paths) remain
    # intact.
    git -C "$repo_root" ls-tree -r -z --full-tree "$commit" -- "${production_inputs[@]}"

    printf 'config:APP_ENV\0%s\0' "${APP_ENV:-development}"
    printf 'config:NEXT_PUBLIC_APP_URL\0%s\0' "${NEXT_PUBLIC_APP_URL:-}"
    printf 'config:VAPID_PUBLIC_KEY\0%s\0' "${VAPID_PUBLIC_KEY:-}"
    printf 'config:NEXT_PUBLIC_SUPPORT_EMAIL\0%s\0' "${NEXT_PUBLIC_SUPPORT_EMAIL:-}"
    printf 'config:NEXT_PUBLIC_SUPPORT_EMAIL_B64\0%s\0' "${NEXT_PUBLIC_SUPPORT_EMAIL_B64:-}"
    printf 'config:OAUTH_MOCK_URL\0%s\0' "${OAUTH_MOCK_URL:-}"
  } | sha256sum | cut -c1-40 | sed 's/^/web-v2-/'
}

resolve_web_version_main() {
  local script_dir default_repo_root repo_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  default_repo_root="$(cd "$script_dir/.." && pwd)"
  repo_root="${1:-$default_repo_root}"

  if ! git -C "$repo_root" rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "Cannot resolve a tracked repository in $repo_root" >&2
    exit 1
  fi

  # Production deploys must remain reproducible even when the dirty file
  # would be excluded from the fingerprint (for example a test or local
  # documentation).
  local dirty_sources
  dirty_sources="$(git -C "$repo_root" status --porcelain --untracked-files=normal -- web scripts/resolve_web_version.sh)"
  if [[ -n "$dirty_sources" ]]; then
    echo "Cannot calculate a production web version from dirty web sources:" >&2
    printf '%s\n' "$dirty_sources" >&2
    exit 1
  fi

  local version
  if ! version="$(web_version_fingerprint "$repo_root" HEAD)"; then
    echo "Cannot resolve tracked production web inputs in $repo_root" >&2
    exit 1
  fi

  printf '%s\n' "$version"
}

# Only run the CLI behavior (dirty-tree checks, HEAD resolution) when this
# file is executed directly. resolve_web_version_history.sh sources it to
# reuse `production_inputs` and `web_version_fingerprint` for other commits.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  resolve_web_version_main "$@"
fi
