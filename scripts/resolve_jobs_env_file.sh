#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "Usage: $0 <prefect|development|production|test>" >&2
  exit 1
fi

case "$mode" in
  prefect)
    override_var="BESEDY_JOBS_ENV_PREFECT"
    config_name="jobs.env.prefect"
    ;;
  development | dev)
    override_var="BESEDY_JOBS_ENV_DEV"
    config_name="jobs.env.dev"
    ;;
  production | prod)
    override_var="BESEDY_JOBS_ENV_PROD"
    config_name="jobs.env.prod"
    ;;
  test)
    override_var="BESEDY_JOBS_ENV_TEST"
    config_name="jobs.env.test"
    ;;
  *)
    echo "Unsupported mode: $mode" >&2
    echo "Expected one of: prefect, development, production, test" >&2
    exit 1
    ;;
esac

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

config_home="$(resolve_config_home)"
override_value="${!override_var:-}"
if [[ -n "$override_value" ]]; then
  override_path="$(normalize_path "$override_value")"
  if [[ -f "$override_path" ]]; then
    printf '%s\n' "$override_path"
    exit 0
  fi
  echo "$override_var points to missing file: $override_path" >&2
  exit 1
fi

canonical_path="$config_home/$config_name"
if [[ -f "$canonical_path" ]]; then
  printf '%s\n' "$canonical_path"
  exit 0
fi

example_path="$repo_root/jobs-service/.env.example"
cat >&2 <<EOF
Jobs env file not found.

Set $override_var to an existing env file, or copy:
  $example_path
to:
  $canonical_path
EOF
exit 1
