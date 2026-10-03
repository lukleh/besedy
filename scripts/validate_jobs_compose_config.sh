#!/usr/bin/env bash

# Check a rendered jobs Compose project (`docker compose config --format json`,
# on stdin) against the environment it was rendered for. A wrong value in a
# jobs env file otherwise connects one environment's jobs runtime to another
# environment's web, work pool or output directory without any error (#192).

set -euo pipefail

mode="${1:-}"
env_file="${2:-<unknown env file>}"

case "$mode" in
  development) suffix="dev" ;;
  test) suffix="test" ;;
  production) suffix="prod" ;;
  *)
    echo "Usage: $0 <development|production|test> [env-file]" >&2
    exit 1
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to validate the rendered jobs Compose configuration" >&2
  exit 1
fi

config="$(cat)"
expected_project="besedy-jobs-$suffix"
expected_web_host="besedy-$mode-web"

fail() {
  echo "Unsafe jobs Compose configuration for $mode: $1 (env file: $env_file)" >&2
  exit 1
}

# The value of an environment variable of a rendered service, or empty.
service_env() {
  jq -r --arg service "$1" --arg key "$2" '.services[$service].environment[$key] // empty' <<<"$config"
}

require_suffix() {
  local service="$1" key="$2" value
  value="$(service_env "$service" "$key")"
  [[ -n "$value" ]] || fail "$service $key is not set, expected a value ending in '-$suffix'"
  [[ "$value" == *"-$suffix" ]] \
    || fail "$service $key is '$value', expected a name ending in '-$suffix'"
}

actual_project="$(jq -r '.name // empty' <<<"$config")"
[[ "$actual_project" == "$expected_project" ]] \
  || fail "project is '$actual_project', expected '$expected_project'"

for service in jobs-api prefect-worker; do
  container_name="$(jq -r --arg service "$service" '.services[$service].container_name // empty' <<<"$config")"
  [[ "$container_name" == "besedy-$suffix-"* ]] \
    || fail "$service container name is '$container_name', expected the prefix 'besedy-$suffix-'"

  output_env="$(service_env "$service" DEEP_SEARCH_OUTPUT_ENV)"
  [[ "$output_env" == "$suffix" ]] \
    || fail "$service DEEP_SEARCH_OUTPUT_ENV is '$output_env', expected '$suffix'"

  output_dir="$(service_env "$service" DEEP_SEARCH_OUTPUT_DIR)"
  [[ "${output_dir%/}" == */"$suffix" ]] \
    || fail "$service DEEP_SEARCH_OUTPUT_DIR is '$output_dir', expected a directory ending in '/$suffix'"

  require_suffix "$service" PREFECT_DEEP_SEARCH_WORK_POOL
done

require_suffix jobs-api PREFECT_INGEST_WORK_POOL

# The worker serves the pool named on its command line, not the variable.
worker_pool="$(jq -r '
  .services["prefect-worker"].command as $command
  | ($command | index("--pool")) as $i
  | if $i == null then "" else $command[$i + 1] // "" end
' <<<"$config")"
[[ "$worker_pool" == *"-$suffix" ]] \
  || fail "prefect-worker pool is '$worker_pool', expected a name ending in '-$suffix'"

internal_base_url="$(service_env prefect-worker BESEDY_INTERNAL_BASE_URL)"
[[ -n "$internal_base_url" ]] \
  || fail "prefect-worker BESEDY_INTERNAL_BASE_URL is not set, expected http://$expected_web_host:3000"
internal_host="${internal_base_url#*://}"
internal_host="${internal_host%%[:/]*}"
[[ "$internal_host" == "$expected_web_host" ]] \
  || fail "prefect-worker BESEDY_INTERNAL_BASE_URL is '$internal_base_url', expected http://$expected_web_host:3000"
