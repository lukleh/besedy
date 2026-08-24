#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "Usage: $0 <development|production|test> [docker compose arguments...]" >&2
  exit 1
fi
shift

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
env_file="$("$script_dir/resolve_web_env_file.sh" "$mode")"

if [[ "$mode" == "production" ]]; then
  for compose_arg in "$@"; do
    case "$compose_arg" in
      up | create | run)
        "$script_dir/validate_web_config_mount.sh" production
        break
        ;;
    esac
  done
fi

case "$mode" in
  development)
    compose_args=(-f docker-compose.yml -f docker-compose.dev.yml --profile mock-oauth)
    ;;
  production)
    compose_args=(-f docker-compose.yml -f docker-compose.secure.yml --profile backup)
    ;;
  test)
    compose_args=(-f docker-compose.yml -f docker-compose.secure.yml --profile mock-oauth)
    ;;
  *)
    echo "Unsupported mode: $mode" >&2
    echo "Expected one of: development, production, test" >&2
    exit 1
    ;;
esac

cd "$repo_root/web"
exec docker compose "${compose_args[@]}" --env-file "$env_file" "$@"
