#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

normalize_path() {
  local raw="$1"
  if [[ "$raw" = /* ]]; then
    printf '%s\n' "$raw"
  else
    printf '%s\n' "$repo_root/$raw"
  fi
}

resolve_config_home() {
  local xdg_root="${XDG_CONFIG_HOME:-$HOME/.config}"
  xdg_root="$(normalize_path "$xdg_root")"
  printf '%s\n' "$xdg_root/lukleh/besedy"
}

override_value="${BESEDY_OPS_ENV:-}"
if [[ -n "$override_value" ]]; then
  override_path="$(normalize_path "$override_value")"
  if [[ -f "$override_path" ]]; then
    printf '%s\n' "$override_path"
    exit 0
  fi
  echo "BESEDY_OPS_ENV points to missing file: $override_path" >&2
  exit 1
fi

printf '%s\n' "$(resolve_config_home)/ops.env"
