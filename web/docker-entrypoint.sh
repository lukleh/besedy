#!/bin/sh
set -e

# Migrations run manually from the host via `just prod-migrate`
# This keeps the migrator password out of the container

LOG_DIR="${WEB_LOG_DIR:-/var/log/besedy}"
LOG_FILE_PREFIX="${WEB_LOG_FILE_PREFIX:-web}"
ENABLE_FILE_LOGGING="${WEB_ENABLE_FILE_LOGGING:-true}"
LOG_UMASK="${WEB_LOG_UMASK:-022}"

require_env() {
  var_name="$1"
  eval "var_value=\${$var_name:-}"
  if [ -z "$var_value" ]; then
    echo "ERROR: $var_name must be set in production"
    exit 1
  fi
}

run_with_daily_log_files() {
  pipe_dir="$(mktemp -d /tmp/web-log-pipe.XXXXXX)"
  pipe_path="${pipe_dir}/stream"
  mkfifo "$pipe_path"

  current_date="$(date +%F)"
  current_file="${LOG_DIR}/${LOG_FILE_PREFIX}-${current_date}.log"

  (
    umask "$LOG_UMASK"
    while IFS= read -r line || [ -n "$line" ]; do
      next_date="$(date +%F)"
      if [ "$next_date" != "$current_date" ]; then
        current_date="$next_date"
        current_file="${LOG_DIR}/${LOG_FILE_PREFIX}-${current_date}.log"
      fi
      printf '%s\n' "$line" >> "$current_file"
      printf '%s\n' "$line"
    done < "$pipe_path"
  ) &
  logger_pid=$!

  "$@" > "$pipe_path" 2>&1 &
  app_pid=$!

  trap 'if [ -n "${app_pid:-}" ]; then kill -TERM "$app_pid" 2>/dev/null || true; fi' TERM
  trap 'if [ -n "${app_pid:-}" ]; then kill -INT "$app_pid" 2>/dev/null || true; fi' INT
  trap 'if [ -n "${app_pid:-}" ]; then kill -HUP "$app_pid" 2>/dev/null || true; fi' HUP

  app_status=0
  wait "$app_pid" || app_status=$?

  wait "$logger_pid" || true
  rm -f "$pipe_path"
  rmdir "$pipe_dir" 2>/dev/null || true
  trap - TERM INT HUP

  exit "$app_status"
}

echo "Starting application..."
if [ "${APP_ENV}" = "production" ]; then
  require_env GIT_COMMIT
  if [ "${GIT_COMMIT}" = "unknown" ]; then
    echo "ERROR: GIT_COMMIT must be set in production"
    exit 1
  fi

  if [ -z "${AUTH_SECRET:-}" ] && [ -z "${BETTER_AUTH_SECRET:-}" ]; then
    echo "ERROR: AUTH_SECRET or BETTER_AUTH_SECRET must be set in production"
    exit 1
  fi

  require_env DATABASE_URL
  require_env AUTH_URL
  require_env NEXT_PUBLIC_APP_URL
  require_env AUTH_GOOGLE_ID
  require_env AUTH_GOOGLE_SECRET
  require_env VAPID_PUBLIC_KEY
  require_env VAPID_PRIVATE_KEY

  if [ "${AUTH_URL}" != "${NEXT_PUBLIC_APP_URL}" ]; then
    echo "ERROR: AUTH_URL must match NEXT_PUBLIC_APP_URL in production"
    exit 1
  fi
fi

if [ "${ENABLE_FILE_LOGGING}" = "true" ] || [ "${ENABLE_FILE_LOGGING}" = "1" ]; then
  if mkdir -p "$LOG_DIR" 2>/dev/null && touch "$LOG_DIR/.write_test" 2>/dev/null; then
    rm -f "$LOG_DIR/.write_test"
    run_with_daily_log_files "$@"
  else
    echo "WARN: file logging disabled; cannot write to $LOG_DIR"
  fi
fi

exec "$@"
