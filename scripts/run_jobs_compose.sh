#!/usr/bin/env bash

# Run docker compose for one environment's jobs runtime (the jobs-api and
# prefect-worker containers). Before any command, the rendered project is
# checked against that environment (validate_jobs_compose_config.sh), so a
# wrong value in the jobs env file cannot silently point one environment's
# jobs at another environment's web, work pool or output directory.

set -euo pipefail

usage="Usage: $0 <development|production|test> [--codex-auth] <docker compose command and arguments...>"

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "$usage" >&2
  exit 1
fi
shift

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

case "$mode" in
  development) compose_file="jobs-service/docker-compose.jobs-dev.yml" ;;
  test) compose_file="jobs-service/docker-compose.jobs-test.yml" ;;
  production) compose_file="jobs-service/docker-compose.jobs-prod.yml" ;;
  *)
    echo "Unsupported mode: $mode" >&2
    echo "Expected one of: development, production, test" >&2
    exit 1
    ;;
esac

compose_files=(-f "$compose_file")
while (( $# > 0 )); do
  case "$1" in
    --codex-auth)
      if [[ "$mode" != "production" ]]; then
        echo "--codex-auth is only valid for production" >&2
        exit 1
      fi
      compose_files+=(-f jobs-service/docker-compose.jobs-codex-auth.yml)
      shift
      ;;
    -p | -p?* | --project-name | --project-name=* | -f | -f?* | --file | --file=* | --env-file | --env-file=* | --project-directory | --project-directory=*)
      echo "Unsafe Docker Compose option '$1': project identity, Compose files, and env files are controlled by this wrapper" >&2
      exit 1
      ;;
    -*)
      echo "Unsupported Docker Compose global option '$1'; none may precede the command" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if (( $# == 0 )); then
  echo "A Docker Compose command is required" >&2
  echo "$usage" >&2
  exit 1
fi

env_file="$("$script_dir/resolve_jobs_env_file.sh" "$mode")"
cd "$repo_root"
compose_command=(docker compose --env-file "$env_file" "${compose_files[@]}")

compose_status=0
rendered_config="$("${compose_command[@]}" config --format json)" || compose_status=$?
if (( compose_status != 0 )); then
  echo "Docker Compose could not render the $mode jobs project (env file: $env_file)" >&2
  exit "$compose_status"
fi
printf '%s\n' "$rendered_config" | "$script_dir/validate_jobs_compose_config.sh" "$mode" "$env_file"

exec "${compose_command[@]}" "$@"
