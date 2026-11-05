#!/usr/bin/env bash

# Check a rendered jobs Compose project (`docker compose config --format json`,
# on stdin) against the environment it was rendered for. A wrong value in a
# jobs env file otherwise connects one environment's jobs runtime to another
# environment's work pool or deployment without any error (#192).

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

container_name="$(jq -r '.services["jobs-api"].container_name // empty' <<<"$config")"
[[ "$container_name" == "besedy-$suffix-jobs-api" ]] \
  || fail "jobs-api container name is '$container_name', expected 'besedy-$suffix-jobs-api'"

require_suffix jobs-api PREFECT_INGEST_WORK_POOL

# Deployments are registered and run by name: another environment's names would
# overwrite its deployments, or submit runs to them.
for key in \
  PREFECT_INGEST_DEPLOYMENT_NAME PREFECT_INGEST_FULL_DEPLOYMENT_NAME \
  PREFECT_INGEST_REMOVE_DEPLOYMENT_NAME PREFECT_INGEST_REMOVE_FULL_DEPLOYMENT_NAME \
  PREFECT_CORRECTION_INDEX_DEPLOYMENT_NAME PREFECT_CORRECTION_INDEX_FULL_DEPLOYMENT_NAME; do
  require_suffix jobs-api "$key"
done
