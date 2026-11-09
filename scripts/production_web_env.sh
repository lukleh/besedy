#!/usr/bin/env bash
# Shared setup for production recipes. Sourced; never starts or stops services.

production_web_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_production_web_env() {
  env_file="$(bash "$production_web_scripts_dir/resolve_web_env_file.sh" production)" || return
  if [[ ! -f "$env_file" ]]; then
    echo "Missing production env file: $env_file" >&2
    return 1
  fi
  set -a
  . "$env_file"
  set +a
}

validate_production_web_env() {
  local name
  for name in AUTH_URL NEXT_PUBLIC_APP_URL AUTH_SECRET AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
    DATABASE_URL VAPID_PUBLIC_KEY NEXT_PUBLIC_VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
    if [[ -z "${!name:-}" ]]; then
      echo "Missing required env: $name ($env_file)" >&2
      return 1
    fi
  done
  if [[ "$NEXT_PUBLIC_APP_URL" != "$AUTH_URL" ]]; then
    echo "NEXT_PUBLIC_APP_URL must match AUTH_URL for production" >&2
    return 1
  fi
  if [[ "$NEXT_PUBLIC_VAPID_PUBLIC_KEY" != "$VAPID_PUBLIC_KEY" ]]; then
    echo "NEXT_PUBLIC_VAPID_PUBLIC_KEY must match VAPID_PUBLIC_KEY for production" >&2
    return 1
  fi
}

set_production_web_version() {
  GIT_COMMIT="$(git rev-parse HEAD)" || return
  WEB_VERSION="$(bash "$production_web_scripts_dir/resolve_web_version.sh")" || return
  BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")" || return
  export GIT_COMMIT WEB_VERSION BUILD_TIME
}
