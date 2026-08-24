#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "Usage: $0 <development|production|test>" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
env_file="$($script_dir/resolve_web_env_file.sh "$mode")"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

config_file="${CONFIG_FILE:-}"
config_mount="${CONFIG_MOUNT:-/data/config/besedy.docker.toml}"
runtime_config="${BESEDY_CONFIG:-}"

fail() {
  echo "Invalid $mode web config mount: $*" >&2
  exit 1
}

[[ -n "$config_file" ]] || fail "CONFIG_FILE is not set in $env_file"
[[ -n "$runtime_config" ]] || fail "BESEDY_CONFIG is not set in $env_file"
[[ "$config_mount" = /* ]] || fail "CONFIG_MOUNT must be an absolute container path"
[[ "$runtime_config" = "$config_mount" ]] || fail \
  "BESEDY_CONFIG ($runtime_config) must match CONFIG_MOUNT ($config_mount)"

if [[ "$mode" == "production" && "$config_file" != /* ]]; then
  fail "CONFIG_FILE must be an absolute host path outside the checkout; got $config_file"
fi

if [[ "$mode" == "production" ]]; then
  case "$config_file" in
    "$repo_root" | "$repo_root"/*)
      fail "CONFIG_FILE must live outside the checkout; symlinks inside it are not allowed: $config_file"
      ;;
  esac
fi

resolved_config="$config_file"
if [[ "$resolved_config" != /* ]]; then
  resolved_config="$repo_root/web/${resolved_config#./}"
fi

[[ -e "$resolved_config" ]] || fail \
  "CONFIG_FILE does not exist: $resolved_config (Docker would create a directory at a missing bind source)"
[[ -f "$resolved_config" ]] || fail "CONFIG_FILE is not a regular file: $resolved_config"
[[ -r "$resolved_config" ]] || fail "CONFIG_FILE is not readable by the deployment user: $resolved_config"
resolved_config="$(realpath -e "$resolved_config")"

if [[ "$mode" == "production" ]]; then
  case "$resolved_config" in
    "$repo_root" | "$repo_root"/*)
      fail "CONFIG_FILE must live outside the checkout so release worktrees cannot replace it: $resolved_config"
      ;;
  esac

  permissions="$(stat -Lc '%a' "$resolved_config")"
  other_permissions=$((8#${permissions: -1}))
  if (( (other_permissions & 4) == 0 )); then
    fail "CONFIG_FILE must be readable by the container's unprivileged user (for example, chmod 644 $resolved_config)"
  fi
fi

echo "Validated $mode web config mount: $resolved_config -> $config_mount"
