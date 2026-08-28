#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
instance="${2:-}"

if [[ -z "$mode" || -z "$instance" ]]; then
  echo "Usage: $0 <development|production|test> <compose-instance>" >&2
  exit 1
fi

case "$mode" in
  development | production | test) ;;
  *)
    echo "Unsupported mode: $mode" >&2
    exit 1
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to validate the rendered web Compose configuration" >&2
  exit 1
fi

config="$(cat)"
expected_project="besedy-$instance"

fail() {
  echo "Unsafe web Compose configuration for $mode: $1" >&2
  exit 1
}

actual_project="$(jq -r '.name // empty' <<<"$config")"
[[ "$actual_project" == "$expected_project" ]] \
  || fail "project is '$actual_project', expected '$expected_project'"

actual_app_env="$(jq -r '.services.web.environment.APP_ENV // empty' <<<"$config")"
[[ "$actual_app_env" == "$mode" ]] \
  || fail "web APP_ENV is '$actual_app_env', expected '$mode'"

invalid_container_names="$(
  jq -r --arg project "$expected_project" '
    .services
    | to_entries[]
    | select(.value.container_name != null)
    | .expected_suffix = (if .key == "oauth-mock" then "oauth" else .key end)
    | select(.value.container_name != ($project + "-" + .expected_suffix))
    | "\(.key)=\(.value.container_name)"
  ' <<<"$config"
)"
[[ -z "$invalid_container_names" ]] \
  || fail "unexpected container names: ${invalid_container_names//$'\n'/, }"

db_volume_key="$(
  jq -r '.services.db.volumes[] | select(.type == "volume") | .source' <<<"$config"
)"
db_volume_target="$(
  jq -r '.services.db.volumes[] | select(.type == "volume") | .target' <<<"$config"
)"
db_image="$(jq -r '.services.db.image // empty' <<<"$config")"

[[ "$db_image" == "pgvector/pgvector:pg18" ]] \
  || fail "database image is '$db_image', expected 'pgvector/pgvector:pg18'"
[[ "$db_volume_key" == "postgres_data" ]] \
  || fail "database volume key is '$db_volume_key', expected 'postgres_data'"
[[ "$db_volume_target" == "/var/lib/postgresql" ]] \
  || fail "PostgreSQL 18 volume target is '$db_volume_target', expected '/var/lib/postgresql'"

if [[ "$mode" == "production" ]]; then
  [[ "$instance" == "production" ]] \
    || fail "production must use the 'production' Compose instance"
  actual_volume_name="$(jq -r '.volumes.postgres_data.name // empty' <<<"$config")"
  [[ "$actual_volume_name" == "besedy_production_postgres" ]] \
    || fail "database volume is '$actual_volume_name', expected 'besedy_production_postgres'"
  jq -e '.volumes.postgres_data.external == true' <<<"$config" >/dev/null \
    || fail "production database volume must be external"
else
  expected_volume="besedy_${instance}_postgres"
  actual_volume_name="$(jq -r '.volumes.postgres_data.name // empty' <<<"$config")"
  [[ "$actual_volume_name" == "$expected_volume" ]] \
    || fail "database volume is '$actual_volume_name', expected '$expected_volume'"
  if grep -qE 'besedy-production|besedy_production_postgres' <<<"$config"; then
    fail "non-production config references a production Docker resource"
  fi
fi
