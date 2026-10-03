#!/usr/bin/env bash

# Render every Docker Compose stack of the repository with its example env
# file, with all profiles enabled. A broken interpolation, a removed file or an
# invalid service definition fails here instead of at deploy time. Only the
# configuration is rendered; nothing is built or started.
#
# Usage: scripts/check_compose_renders.sh
# Needs docker compose and jq (the web wrapper validates the rendered project).

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

failures=()

# check <name> <command...>: run quietly, print Compose's output only on failure.
check() {
  local name="$1"
  shift
  local output
  if output="$("$@" 2>&1 >/dev/null)"; then
    echo "ok      $name"
  else
    echo "FAILED  $name"
    printf '%s\n' "$output" | sed 's/^/        /'
    failures+=("$name")
  fi
}

# Every compose file below is listed here, and tests/test_compose_render_check.py
# fails when a docker-compose*.yml of the repository is missing from this list.

# Web: run_web_compose.sh picks the compose files and validates the project.
web_example() {
  # <mode> <env var> <example file>
  env "$2=$repo_root/web/$3" bash scripts/run_web_compose.sh "$1" --profile '*' config -q
}
check "web development (web/docker-compose.yml, docker-compose.dev.yml)" \
  web_example development BESEDY_WEB_ENV_DEV .env.dev.example
check "web test (web/docker-compose.yml, docker-compose.secure.yml)" \
  web_example test BESEDY_WEB_ENV_TEST .env.test.example
check "web production (web/docker-compose.yml, docker-compose.secure.yml, docker-compose.production.yml)" \
  web_example production BESEDY_WEB_ENV_PROD .env.prod.example

# Jobs and Prefect: the example env files are the documented starting point.
jobs_example() {
  # <env example> <compose file...>
  local example="$1"
  shift
  local args=()
  for file in "$@"; do
      args+=(-f "$file")
  done
  docker compose --env-file "jobs-service/$example" "${args[@]}" --profile '*' config -q
}
check "prefect (jobs-service/docker-compose.prefect.yml)" \
  jobs_example .env.prefect.example jobs-service/docker-compose.prefect.yml
check "jobs development (jobs-service/docker-compose.jobs-dev.yml)" \
  jobs_example .env.dev.example jobs-service/docker-compose.jobs-dev.yml
check "jobs test (jobs-service/docker-compose.jobs-test.yml)" \
  jobs_example .env.test.example jobs-service/docker-compose.jobs-test.yml
check "jobs production (jobs-service/docker-compose.jobs-prod.yml)" \
  jobs_example .env.prod.example jobs-service/docker-compose.jobs-prod.yml
# The Codex overlay requires an auth file path; the render does not read it.
check "jobs production with the Codex overlay (jobs-service/docker-compose.jobs-codex-auth.yml)" \
  env CODEX_HOST_AUTH_FILE=/nonexistent/auth.json bash -c \
  'docker compose --env-file jobs-service/.env.prod.example -f jobs-service/docker-compose.jobs-prod.yml -f jobs-service/docker-compose.jobs-codex-auth.yml config -q'

# Model serving: no env file, defaults only.
check "rag services (rag-services/docker-compose.yml)" \
  docker compose -f rag-services/docker-compose.yml --profile '*' config -q
check "backends (backends/docker-compose.yml)" \
  docker compose -f backends/docker-compose.yml --profile '*' config -q

if (( ${#failures[@]} > 0 )); then
  echo
  echo "${#failures[@]} compose render(s) failed: ${failures[*]}" >&2
  exit 1
fi
