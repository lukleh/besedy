#!/usr/bin/env bash
# Daily health check for host-side Besedy snapshot coverage.

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
ALERT_EMAIL="${ALERT_EMAIL:-${REPORT_EMAIL:-}}"
TAG="besedy-host-backup"

OPS_ENV_FILE="$("$PROJECT_DIR/scripts/resolve_ops_env_file.sh")"
if [ -f "$OPS_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OPS_ENV_FILE"
    set +a
fi

: "${PROJECT_SNAPSHOT_ROOT:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
: "${EXTRA_SNAPSHOT_ROOT:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
: "${PROJECT_LOG_FILE:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
: "${EXTRA_LOG_FILE:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
EXTRA_MAP_FILE="${EXTRA_MAP_FILE:-$COMPOSE_DIR/setup/backup/besedy-extra.paths}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-30}"
REMOTE_SYNC_MAX_AGE_HOURS="${REMOTE_SYNC_MAX_AGE_HOURS:-$MAX_AGE_HOURS}"
PROJECT_REQUIRED_PATHS="${PROJECT_REQUIRED_PATHS:-projects/besedy,projects/besedy_data,projects/besedy_posters,projects/besedy_sources}"
DB_DUMP_PATTERN="${DB_DUMP_PATTERN:-besedy_[0-9]*_[0-9]*.sql.gz}"

declare -a failures=()
declare -a info=()
declare -a EXTRA_REQUIRED_PATHS=()

PROJECT_LATEST_SNAPSHOT=""
EXTRA_LATEST_SNAPSHOT=""
LATEST_EXTRA_DB_DUMP=""

send_alert() {
    local subject="$1"
    local body="$2"

    logger -t "$TAG" "$subject"
    if [ -z "$ALERT_EMAIL" ]; then
        logger -t "$TAG" "No ALERT_EMAIL configured; alert content: $body"
        return 0
    fi

    if {
        echo "Subject: $subject"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "$body"
    } | sendmail "$ALERT_EMAIL"; then
        logger -t "$TAG" "Alert email sent to $ALERT_EMAIL"
    else
        logger -t "$TAG" "Failed to send alert email to $ALERT_EMAIL"
    fi
}

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

normalize_label() {
    local label="$1"
    label="${label#/}"
    label="${label%/}"
    printf '%s' "$label"
}

is_positive_int() {
    case "$1" in
        ''|*[!0-9]*|0)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

latest_snapshot_dir() {
    local snapshot_root="$1"
    find "$snapshot_root" -mindepth 1 -maxdepth 1 -type d \
        \( -name 'daily.*' -o -name 'weekly.*' -o -name 'monthly.*' -o -name 'yearly.*' \) \
        -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-
}

snapshot_age_hours() {
    local path="$1"
    local now_epoch
    local target_epoch
    now_epoch="$(date +%s)"
    target_epoch="$(stat -c %Y "$path" 2>/dev/null || echo 0)"
    echo $(( (now_epoch - target_epoch) / 3600 ))
}

load_extra_required_paths() {
    if [ ! -f "$EXTRA_MAP_FILE" ]; then
        failures+=("Extra backup map file missing: $EXTRA_MAP_FILE")
        return 0
    fi

    local line=""
    local label=""
    local lineno=0

    while IFS= read -r line || [ -n "$line" ]; do
        lineno=$((lineno + 1))
        line="$(trim_whitespace "$line")"
        case "$line" in
            ''|\#*)
                continue
                ;;
        esac

        if [[ "$line" != *"|"* ]]; then
            failures+=("Invalid mapping on line $lineno in $EXTRA_MAP_FILE (expected source|label)")
            continue
        fi

        label="$(normalize_label "$(trim_whitespace "${line#*|}")")"
        if [ -z "$label" ]; then
            failures+=("Invalid mapping on line $lineno in $EXTRA_MAP_FILE (empty label)")
            continue
        fi

        EXTRA_REQUIRED_PATHS+=("$label")
    done < "$EXTRA_MAP_FILE"

    if [ "${#EXTRA_REQUIRED_PATHS[@]}" -eq 0 ]; then
        failures+=("No extra backup labels found in $EXTRA_MAP_FILE")
    fi
}

check_snapshot_root() {
    local name="$1"
    local snapshot_root="$2"
    local required_csv="$3"
    local latest_snapshot=""
    local age_hours=0
    local required_path=""
    local -a required_paths=()

    if [ ! -d "$snapshot_root" ]; then
        failures+=("$name snapshot root missing: $snapshot_root")
        return 0
    fi

    latest_snapshot="$(latest_snapshot_dir "$snapshot_root")"
    if [ -z "$latest_snapshot" ]; then
        failures+=("No $name snapshots found in $snapshot_root")
        return 0
    fi

    age_hours="$(snapshot_age_hours "$latest_snapshot")"
    info+=("${name}_latest_snapshot=$latest_snapshot")
    info+=("${name}_age_hours=$age_hours")

    if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
        failures+=("Latest $name snapshot is too old: ${age_hours}h (threshold ${MAX_AGE_HOURS}h)")
    fi

    IFS=',' read -r -a required_paths <<< "$required_csv"
    for required_path in "${required_paths[@]}"; do
        required_path="$(trim_whitespace "$required_path")"
        [ -n "$required_path" ] || continue

        if [ ! -e "$latest_snapshot/$required_path" ]; then
            failures+=("$name snapshot missing required path: $latest_snapshot/$required_path")
        else
            info+=("${name}_path_ok=$required_path")
        fi
    done

    case "$name" in
        project)
            PROJECT_LATEST_SNAPSHOT="$latest_snapshot"
            ;;
        extra)
            EXTRA_LATEST_SNAPSHOT="$latest_snapshot"
            ;;
    esac
}

check_remote_sync() {
    local name="$1"
    local log_file="$2"
    local last_success=""
    local timestamp=""
    local sync_epoch=0
    local age_hours=0
    local now_epoch=0

    if [ ! -f "$log_file" ]; then
        failures+=("$name remote sync log missing: $log_file")
        return 0
    fi

    last_success="$(grep 'Remote snapshot sync completed successfully\.' "$log_file" | tail -n1 || true)"
    if [ -z "$last_success" ]; then
        failures+=("No successful $name remote sync found in $log_file")
        return 0
    fi

    timestamp="$(printf '%s\n' "$last_success" | sed -n 's/^\[\(.*\)\] Remote snapshot sync completed successfully\.$/\1/p')"
    if [ -z "$timestamp" ]; then
        failures+=("Failed to parse last successful $name remote sync timestamp from $log_file")
        return 0
    fi

    sync_epoch="$(date -d "$timestamp" +%s 2>/dev/null || echo 0)"
    if [ "$sync_epoch" -eq 0 ]; then
        failures+=("Failed to parse $name remote sync timestamp: $timestamp")
        return 0
    fi

    now_epoch="$(date +%s)"
    age_hours=$(( (now_epoch - sync_epoch) / 3600 ))
    info+=("${name}_remote_sync_completed=$timestamp")
    info+=("${name}_remote_sync_age_hours=$age_hours")

    if [ "$age_hours" -gt "$REMOTE_SYNC_MAX_AGE_HOURS" ]; then
        failures+=("Latest $name remote sync is too old: ${age_hours}h (threshold ${REMOTE_SYNC_MAX_AGE_HOURS}h)")
    fi
}

check_extra_db_dump() {
    if [ -z "$EXTRA_LATEST_SNAPSHOT" ]; then
        return 0
    fi

    local db_dump_root="$EXTRA_LATEST_SNAPSHOT/state/db_dumps"
    if [ ! -d "$db_dump_root" ]; then
        failures+=("Extra snapshot missing DB dump directory: $db_dump_root")
        return 0
    fi

    LATEST_EXTRA_DB_DUMP="$(
        find "$db_dump_root" -maxdepth 1 -type f -name "$DB_DUMP_PATTERN" \
            -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-
    )"
    if [ -z "$LATEST_EXTRA_DB_DUMP" ]; then
        failures+=("No DB dump matching $DB_DUMP_PATTERN found in $db_dump_root")
        return 0
    fi

    info+=("extra_latest_db_dump=$LATEST_EXTRA_DB_DUMP")
}

if ! is_positive_int "$MAX_AGE_HOURS"; then
    echo "MAX_AGE_HOURS must be a positive integer, got: $MAX_AGE_HOURS" >&2
    exit 1
fi

if ! is_positive_int "$REMOTE_SYNC_MAX_AGE_HOURS"; then
    echo "REMOTE_SYNC_MAX_AGE_HOURS must be a positive integer, got: $REMOTE_SYNC_MAX_AGE_HOURS" >&2
    exit 1
fi

load_extra_required_paths
check_snapshot_root "project" "$PROJECT_SNAPSHOT_ROOT" "$PROJECT_REQUIRED_PATHS"
check_snapshot_root "extra" "$EXTRA_SNAPSHOT_ROOT" "$(IFS=,; echo "${EXTRA_REQUIRED_PATHS[*]}")"
check_remote_sync "project" "$PROJECT_LOG_FILE"
check_remote_sync "extra" "$EXTRA_LOG_FILE"
check_extra_db_dump

if [ "${#failures[@]}" -gt 0 ]; then
    body="Besedy host backup coverage check failed on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S %Z').

Failures:
$(printf ' - %s\n' "${failures[@]}")

Context:
$(printf ' - %s\n' "${info[@]}")

Suggested checks:
 - ls -lah $PROJECT_SNAPSHOT_ROOT
 - ls -lah $EXTRA_SNAPSHOT_ROOT
 - tail -n 100 $PROJECT_LOG_FILE
 - tail -n 100 $EXTRA_LOG_FILE"

    send_alert "[Besedy] Host backup coverage check FAILED" "$body"
    printf '%s\n' "$body"
    exit 1
fi

summary="Host backup coverage OK on $(hostname): $(printf '%s; ' "${info[@]}")"
logger -t "$TAG" "$summary"
echo "$summary"
