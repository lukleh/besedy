#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/.." && pwd)"
repo_root="${1:-$default_repo_root}"

if ! git -C "$repo_root" rev-parse --verify HEAD:web >/dev/null 2>&1; then
  echo "Cannot resolve the tracked web tree in $repo_root" >&2
  exit 1
fi

dirty_web="$(git -C "$repo_root" status --porcelain --untracked-files=normal -- web)"
if [[ -n "$dirty_web" ]]; then
  echo "Cannot calculate a production web version from dirty web sources:" >&2
  printf '%s\n' "$dirty_web" >&2
  exit 1
fi

web_tree="$(git -C "$repo_root" rev-parse HEAD:web)"
printf 'web-v1-%s\n' "$web_tree"
