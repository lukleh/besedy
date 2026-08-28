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

user_compose_args=()
command_args=()
while (( $# > 0 )); do
  case "$1" in
    --profile)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        echo "--profile requires a non-empty value" >&2
        exit 1
      fi
      user_compose_args+=(--profile "$2")
      shift 2
      ;;
    --profile=*)
      profile="${1#*=}"
      if [[ -z "$profile" ]]; then
        echo "--profile requires a non-empty value" >&2
        exit 1
      fi
      user_compose_args+=(--profile "$profile")
      shift
      ;;
    -p | -p?* | --project-name | --project-name=* | -f | -f?* | --file | --file=* | --env-file | --env-file=* | --project-directory | --project-directory=*)
      echo "Unsafe Docker Compose option '$1': project identity, Compose files, and env files are controlled by this wrapper" >&2
      exit 1
      ;;
    -*)
      echo "Unsupported Docker Compose global option '$1'; only --profile may precede the command" >&2
      exit 1
      ;;
    *)
      command_args=("$@")
      break
      ;;
  esac
done

if (( ${#command_args[@]} == 0 )); then
  echo "A Docker Compose command is required" >&2
  exit 1
fi

compose_command_name="${command_args[0]}"
changes_resources=false
case "$compose_command_name" in
  up | create | run | scale | watch)
    changes_resources=true
    ;;
esac

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

if [[ "$mode" == "production" && "$changes_resources" == true ]]; then
  "$script_dir/validate_web_config_mount.sh" production
fi

internal_network="${BESEDY_INTERNAL_NETWORK:-besedy-internal}"
if [[ ! "$internal_network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Unsafe BESEDY_INTERNAL_NETWORK '$internal_network': expected a Docker network name" >&2
  exit 1
fi
if [[ "$internal_network" == *_default ]]; then
  echo "Unsafe BESEDY_INTERNAL_NETWORK '$internal_network': a Compose default network cannot be shared" >&2
  exit 1
fi

dry_run=false
for compose_arg in "${command_args[@]}"; do
  if [[ "$compose_arg" == "--dry-run" ]]; then
    dry_run=true
    break
  fi
done

clean_env=(
  env -i
  "APP_ENV=$expected_app_env"
  "BESEDY_COMPOSE_INSTANCE=$instance"
  "BESEDY_INTERNAL_NETWORK=$internal_network"
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
    CONFIG_FILE TEXT_DATA_DIR WEB_PORT DB_PORT AUTH_URL NEXT_PUBLIC_APP_URL
    AUTH_DEV_TRUSTED_ORIGINS BESEDY_MCP_ENABLED RAG_COLBERT_URL
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
  "${user_compose_args[@]}"
  --env-file "$env_file"
)

rendered_config="$("${compose_command[@]}" config --format json)"
printf '%s\n' "$rendered_config" \
  | "$script_dir/validate_web_compose_config.sh" "$mode" "$instance" "$internal_network"

if [[ "$changes_resources" == true ]]; then
  if [[ "$dry_run" == false ]] && ! "${clean_env[@]}" docker network inspect "$internal_network" >/dev/null 2>&1; then
    "${clean_env[@]}" docker network create --driver bridge "$internal_network" >/dev/null \
      || "${clean_env[@]}" docker network inspect "$internal_network" >/dev/null
  fi
fi

exec "${compose_command[@]}" "${command_args[@]}"
