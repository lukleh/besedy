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

case "$mode" in
  development)
    expected_app_env="development"
    instance="development"
    compose_args=(-f docker-compose.yml -f docker-compose.dev.yml --profile mock-oauth)
    ;;
  production)
    expected_app_env="production"
    instance="production"
    compose_args=(-f docker-compose.yml -f docker-compose.secure.yml -f docker-compose.production.yml --profile backup)
    ;;
  test)
    expected_app_env="test"
    instance="${BESEDY_WEB_COMPOSE_INSTANCE:-test}"
    compose_args=(-f docker-compose.yml -f docker-compose.secure.yml --profile mock-oauth)
    ;;
  *)
    echo "Unsupported mode: $mode" >&2
    echo "Expected one of: development, production, test" >&2
    exit 1
    ;;
esac

if [[ "$mode" != "test" && -n "${BESEDY_WEB_COMPOSE_INSTANCE:-}" ]]; then
  echo "BESEDY_WEB_COMPOSE_INSTANCE may only override isolated test projects" >&2
  exit 1
fi

if [[ ! "$instance" =~ ^test(-[a-z0-9][a-z0-9-]*)?$ && "$mode" == "test" ]]; then
  echo "Unsafe test Compose instance '$instance': expected 'test' or a 'test-' prefix" >&2
  exit 1
fi

if (( ${#instance} > 48 )); then
  echo "Compose instance is too long: $instance" >&2
  exit 1
fi

env_file="$("$script_dir/resolve_web_env_file.sh" "$mode")"
declared_app_env="$(
  awk -F= '
    /^[[:space:]]*(export[[:space:]]+)?APP_ENV[[:space:]]*=/ {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
    }
  ' "$env_file" | tail -n 1
)"
declared_app_env="${declared_app_env#\"}"
declared_app_env="${declared_app_env%\"}"
declared_app_env="${declared_app_env#\'}"
declared_app_env="${declared_app_env%\'}"
if [[ "$declared_app_env" != "$expected_app_env" ]]; then
  echo "Unsafe $mode env file: APP_ENV is '$declared_app_env', expected '$expected_app_env' ($env_file)" >&2
  exit 1
fi

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

clean_env=(
  env -i
  "APP_ENV=$expected_app_env"
  "BESEDY_COMPOSE_INSTANCE=$instance"
  "COMPOSE_PROJECT_NAME=besedy-$instance"
  "HOME=${HOME:-}"
  "PATH=$PATH"
)

# Keep only client/build settings that Docker legitimately needs. Application
# configuration comes from the resolved mode-specific env file, never from an
# accidentally sourced shell environment.
passthrough_vars=(
  USER LOGNAME SHELL TERM NO_COLOR TMPDIR XDG_RUNTIME_DIR SSH_AUTH_SOCK
  DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY
  DOCKER_BUILDKIT BUILDKIT_PROGRESS COMPOSE_DOCKER_CLI_BUILD
  HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
  GIT_COMMIT WEB_VERSION BUILD_TIME
)

if [[ -n "${BESEDY_WEB_ALLOW_TEST_OVERRIDES:-}" ]]; then
  if [[ "$mode" != "test" || "$BESEDY_WEB_ALLOW_TEST_OVERRIDES" != "1" ]]; then
    echo "BESEDY_WEB_ALLOW_TEST_OVERRIDES=1 is only valid for test mode" >&2
    exit 1
  fi
  passthrough_vars+=(
    CONFIG_FILE TEXT_DATA_DIR BESEDY_MCP_ENABLED RAG_COLBERT_URL
    RAG_COLBERT_INDEX_DIR RAG_COLBERT_RERANK_ENABLED
  )
fi
for env_name in "${passthrough_vars[@]}"; do
  if [[ -v "$env_name" ]]; then
    clean_env+=("$env_name=${!env_name}")
  fi
done

cd "$repo_root/web"
compose_command=(
  "${clean_env[@]}"
  docker compose
  "${compose_args[@]}"
  --env-file "$env_file"
)

rendered_config="$("${compose_command[@]}" config --format json)"
printf '%s\n' "$rendered_config" \
  | "$script_dir/validate_web_compose_config.sh" "$mode" "$instance"

exec "${compose_command[@]}" "$@"
