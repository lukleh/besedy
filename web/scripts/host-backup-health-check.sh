#!/usr/bin/env bash
# Daily health check for host-side Besedy snapshot coverage.
#
# Exit codes: 0 = healthy, 1 = coverage failure, 3 = trend warning only
# (remote sync getting slow or the synced file count growing quickly).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
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
PROJECT_REQUIRED_PATHS="${PROJECT_REQUIRED_PATHS:-projects/besedy,projects/besedy_data,projects/besedy_artwork,projects/besedy_sources}"
DB_DUMP_PATTERN="${DB_DUMP_PATTERN:-besedy_[0-9]*_[0-9]*.sql.gz}"
# Early-warning thresholds for the remote sync trend (see check_remote_sync_trend).
REMOTE_SYNC_MAX_DURATION_MINUTES="${REMOTE_SYNC_MAX_DURATION_MINUTES:-120}"
REMOTE_SYNC_GROWTH_WINDOW_DAYS="${REMOTE_SYNC_GROWTH_WINDOW_DAYS:-7}"
REMOTE_SYNC_MAX_GROWTH_PERCENT="${REMOTE_SYNC_MAX_GROWTH_PERCENT:-25}"

declare -a failures=()
declare -a warnings=()
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

# Emit one "start|end|file_count" line per successful remote sync in the log.
# The file count comes from the rsync --stats "Number of files:" line.
successful_sync_records() {
    awk '
        /\] Starting remote snapshot sync/ {
            start = substr($0, 2, index($0, "]") - 2)
            count = ""
            next
        }
        /^Number of files: / {
            count = $4
            gsub(",", "", count)
            next
        }
        /\] Remote snapshot sync completed successfully\./ {
            if (start != "") {
                print start "|" substr($0, 2, index($0, "]") - 2) "|" count
            }
            start = ""
            count = ""
            next
        }
        /\] Remote snapshot sync failed/ {
            start = ""
            count = ""
        }
    ' "$1"
}

# Warn before the remote sync starts failing: a sync that keeps getting slower,
# or a file count that jumps, is what preceded the Sep 2026 sync overruns.
check_remote_sync_trend() {
    local name="$1"
    local log_file="$2"
    local -a records=()
    local start="" end="" count=""
    local start_epoch=0 end_epoch=0 duration_minutes=0
    local baseline_end="" baseline_count="" baseline_epoch=0 cutoff_epoch=0
    local growth_percent=0 i=0

    [ -f "$log_file" ] || return 0
    mapfile -t records < <(successful_sync_records "$log_file")
    [ "${#records[@]}" -gt 0 ] || return 0

    IFS='|' read -r start end count <<< "${records[-1]}"
    start_epoch="$(date -d "$start" +%s 2>/dev/null || echo 0)"
    end_epoch="$(date -d "$end" +%s 2>/dev/null || echo 0)"
    if [ "$start_epoch" -gt 0 ] && [ "$end_epoch" -ge "$start_epoch" ]; then
        duration_minutes=$(( (end_epoch - start_epoch) / 60 ))
        info+=("${name}_remote_sync_duration_minutes=$duration_minutes")
        if [ "$duration_minutes" -gt "$REMOTE_SYNC_MAX_DURATION_MINUTES" ]; then
            warnings+=("Latest $name remote sync took ${duration_minutes} min (threshold ${REMOTE_SYNC_MAX_DURATION_MINUTES} min)")
        fi
    fi

    if ! is_positive_int "$count" || [ "$end_epoch" -eq 0 ]; then
        return 0
    fi
    info+=("${name}_remote_sync_files=$count")

    cutoff_epoch=$(( end_epoch - REMOTE_SYNC_GROWTH_WINDOW_DAYS * 86400 ))
    for (( i = ${#records[@]} - 2; i >= 0; i-- )); do
        IFS='|' read -r _ baseline_end baseline_count <<< "${records[i]}"
        baseline_epoch="$(date -d "$baseline_end" +%s 2>/dev/null || echo 0)"
        if [ "$baseline_epoch" -gt 0 ] && [ "$baseline_epoch" -le "$cutoff_epoch" ]; then
            break
        fi
        baseline_count=""
    done

    if ! is_positive_int "$baseline_count"; then
        return 0
    fi
    growth_percent=$(( (count - baseline_count) * 100 / baseline_count ))
    info+=("${name}_remote_sync_files_growth_percent=$growth_percent (vs $baseline_count at $baseline_end)")
    if [ "$growth_percent" -gt "$REMOTE_SYNC_MAX_GROWTH_PERCENT" ]; then
        warnings+=("$name remote sync file count grew ${growth_percent}% in ${REMOTE_SYNC_GROWTH_WINDOW_DAYS}+ days: $baseline_count -> $count (threshold ${REMOTE_SYNC_MAX_GROWTH_PERCENT}%)")
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

for threshold_var in REMOTE_SYNC_MAX_AGE_HOURS REMOTE_SYNC_MAX_DURATION_MINUTES \
    REMOTE_SYNC_GROWTH_WINDOW_DAYS REMOTE_SYNC_MAX_GROWTH_PERCENT; do
    if ! is_positive_int "${!threshold_var}"; then
        echo "$threshold_var must be a positive integer, got: ${!threshold_var}" >&2
        exit 1
    fi
done

load_extra_required_paths
check_snapshot_root "project" "$PROJECT_SNAPSHOT_ROOT" "$PROJECT_REQUIRED_PATHS"
check_snapshot_root "extra" "$EXTRA_SNAPSHOT_ROOT" "$(IFS=,; echo "${EXTRA_REQUIRED_PATHS[*]}")"
check_remote_sync "project" "$PROJECT_LOG_FILE"
check_remote_sync "extra" "$EXTRA_LOG_FILE"
check_remote_sync_trend "project" "$PROJECT_LOG_FILE"
check_remote_sync_trend "extra" "$EXTRA_LOG_FILE"
check_extra_db_dump

suggested_checks=" - ls -lah $PROJECT_SNAPSHOT_ROOT
 - ls -lah $EXTRA_SNAPSHOT_ROOT
 - tail -n 100 $PROJECT_LOG_FILE
 - tail -n 100 $EXTRA_LOG_FILE"
warnings_block=""
if [ "${#warnings[@]}" -gt 0 ]; then
    warnings_block="
Warnings:
$(printf ' - %s\n' "${warnings[@]}")
"
fi

if [ "${#failures[@]}" -gt 0 ]; then
    body="Besedy host backup coverage check failed on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S %Z').

Failures:
$(printf ' - %s\n' "${failures[@]}")
$warnings_block
Context:
$(printf ' - %s\n' "${info[@]}")

Suggested checks:
$suggested_checks"

    send_alert "[Besedy] Host backup coverage check FAILED" "$body"
    printf '%s\n' "$body"
    exit 1
fi

if [ "${#warnings[@]}" -gt 0 ]; then
    body="Besedy host backup trend warning on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S %Z').

Coverage is still OK, but the remote sync is trending toward failure.
$warnings_block
Context:
$(printf ' - %s\n' "${info[@]}")

Suggested checks:
 - $SCRIPT_DIR/backup-growth-report.sh (which top-level directories grew)
 - $SCRIPT_DIR/worktree-report.sh (stale git worktrees)
$suggested_checks"

    send_alert "[Besedy] Host backup trend WARNING" "$body"
    printf '%s\n' "$body"
    exit 3
fi

summary="Host backup coverage OK on $(hostname): $(printf '%s; ' "${info[@]}")"
logger -t "$TAG" "$summary"
echo "$summary"
