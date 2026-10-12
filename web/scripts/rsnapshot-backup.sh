#!/usr/bin/env bash
# Configuration-driven rsnapshot runner with optional daily database hooks.
# Usage: SNAPSHOT_ENV_FILE=/path/to/private/profile.env bash rsnapshot-backup.sh daily
# Settings may also be supplied directly through the environment.
set -euo pipefail

if [ -n "${SNAPSHOT_ENV_FILE:-}" ]; then
    if [ ! -f "$SNAPSHOT_ENV_FILE" ] || [ ! -r "$SNAPSHOT_ENV_FILE" ]; then
        echo "Snapshot configuration is missing or unreadable: $SNAPSHOT_ENV_FILE" >&2
        exit 1
    fi
    set -a
    # Trusted private shell configuration; do not put real values in the repository.
    # shellcheck disable=SC1090
    source "$SNAPSHOT_ENV_FILE"
    set +a
fi

: "${SNAPSHOT_ROOT:?Set SNAPSHOT_ROOT in the private snapshot configuration}"
: "${RSNAPSHOT_CONFIG:?Set RSNAPSHOT_CONFIG in the private snapshot configuration}"
: "${LOG_FILE:?Set LOG_FILE in the private snapshot configuration}"
: "${DETAIL_LOG_FILE:?Set DETAIL_LOG_FILE in the private snapshot configuration}"
: "${LOCK_FILE:?Set LOCK_FILE in the private snapshot configuration}"
: "${RSNAPSHOT_LOCK_FILE:?Set RSNAPSHOT_LOCK_FILE in the private snapshot configuration}"

SOURCE_DIR="${SOURCE_DIR:-}"
BACKUP_LABEL="${BACKUP_LABEL:-projects/}"
SNAPSHOT_MAP_FILE="${SNAPSHOT_MAP_FILE:-}"
SNAPSHOT_INTERVAL="${SNAPSHOT_INTERVAL:-${1:-daily}}"
RETAIN_DAILY="${RETAIN_DAILY:-7}"
RETAIN_WEEKLY="${RETAIN_WEEKLY:-4}"
RETAIN_MONTHLY="${RETAIN_MONTHLY:-12}"
RETAIN_YEARLY="${RETAIN_YEARLY:-5}"
ENABLE_REMOTE_SYNC="${ENABLE_REMOTE_SYNC:-1}"
SYNC_TARGET="${SYNC_TARGET:-}"
PASSWORD_FILE="${PASSWORD_FILE:-}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
RSYNC_LONG_ARGS="${RSYNC_LONG_ARGS:---delete --numeric-ids --delete-excluded}"
EXCLUDE_FILE="${EXCLUDE_FILE:-}"
SYNC_RETRY_CODES="${SYNC_RETRY_CODES:-10 12 30 35}"
SYNC_RETRY_MAX_FIRST_ATTEMPT_MINUTES="${SYNC_RETRY_MAX_FIRST_ATTEMPT_MINUTES:-60}"
SYNC_RETRY_DELAY_SECONDS="${SYNC_RETRY_DELAY_SECONDS:-120}"
BEFORE_SNAPSHOT_HOOK="${BEFORE_SNAPSHOT_HOOK:-}"
AFTER_SYNC_HOOK="${AFTER_SYNC_HOOK:-}"
HOOK_FAILED=0
MAX_LOG_BYTES="${MAX_LOG_BYTES:-52428800}"
MAX_DETAIL_LOG_BYTES="${MAX_DETAIL_LOG_BYTES:-52428800}"

declare -a BACKUP_SOURCES=()
declare -a BACKUP_LABELS=()

ts() {
    date '+%Y-%m-%d %H:%M:%S %Z'
}

log_msg() {
    local message="$1"
    printf '[%s] %s\n' "$(ts)" "$message" >>"$LOG_FILE"
}

send_alert() {
    local subject="$1"
    local body="$2"

    logger -t besedy-backup "$subject"
    if [ -z "$ALERT_EMAIL" ]; then
        return 0
    fi

    if {
        echo "Subject: $subject"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "$body"
    } | sendmail "$ALERT_EMAIL"; then
        logger -t besedy-backup "Alert email sent to $ALERT_EMAIL"
    else
        logger -t besedy-backup "Failed to send alert email to $ALERT_EMAIL"
    fi
}

rotate_log_if_needed() {
    local file_path="$1"
    local max_bytes="${2:-$MAX_LOG_BYTES}"

    if [ ! -f "$file_path" ]; then
        return 0
    fi

    local size_bytes
    size_bytes="$(stat -c %s "$file_path")"
    if [ "$size_bytes" -lt "$max_bytes" ]; then
        return 0
    fi

    local rotated
    rotated="${file_path}.$(date +%Y%m%d_%H%M%S)"
    mv "$file_path" "$rotated"
    gzip -f "$rotated"
}

get_file_line_count() {
    local file_path="$1"

    if [ ! -f "$file_path" ]; then
        echo 0
        return 0
    fi

    wc -l < "$file_path"
}

print_new_log_lines() {
    local file_path="$1"
    local start_line="$2"

    if [ ! -f "$file_path" ]; then
        return 0
    fi

    sed -n "$((start_line + 1)),\$p" "$file_path"
}

extract_rsync_diagnostics() {
    local start_line="$1"

    print_new_log_lines "$DETAIL_LOG_FILE" "$start_line" | grep -E \
        'rsync: |rsync error:|file has vanished:|send_files failed|recv_generator:|mkstemp|Permission denied|No such file or directory|Input/output error' || true
}

is_non_negative_int() {
    local value="$1"
    case "$value" in
        ''|*[!0-9]*)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

append_retain_if_enabled() {
    local interval="$1"
    local count="$2"

    if [ "$count" -gt 0 ]; then
        printf 'retain\t%s\t%s\n' "$interval" "$count" >>"$RSNAPSHOT_CONFIG"
    fi
}

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

normalize_backup_label() {
    local label="$1"
    label="${label#/}"
    case "$label" in
        */)
            ;;
        *)
            label="${label}/"
            ;;
    esac
    printf '%s' "$label"
}

validation_fail() {
    local message="$1"
    log_msg "$message"
    send_alert "[Besedy] Rsnapshot backup FAILED" "$message"
    exit 1
}

load_backup_targets() {
    BACKUP_SOURCES=()
    BACKUP_LABELS=()

    if [ -n "$SNAPSHOT_MAP_FILE" ]; then
        if [ ! -f "$SNAPSHOT_MAP_FILE" ]; then
            validation_fail "Backup failed: SNAPSHOT_MAP_FILE does not exist ($SNAPSHOT_MAP_FILE)"
        fi

        local line=""
        local source_dir=""
        local backup_label=""
        local lineno=0
        declare -A seen_labels=()

        while IFS= read -r line || [ -n "$line" ]; do
            lineno=$((lineno + 1))
            line="$(trim_whitespace "$line")"

            case "$line" in
                ''|\#*)
                    continue
                    ;;
            esac

            if [[ "$line" != *"|"* ]]; then
                validation_fail "Backup failed: invalid mapping on line $lineno in $SNAPSHOT_MAP_FILE (expected source|label)"
            fi

            source_dir="$(trim_whitespace "${line%%|*}")"
            backup_label="$(trim_whitespace "${line#*|}")"

            if [ -z "$source_dir" ] || [ -z "$backup_label" ]; then
                validation_fail "Backup failed: invalid mapping on line $lineno in $SNAPSHOT_MAP_FILE (empty source or label)"
            fi

            if [ ! -d "$source_dir" ]; then
                validation_fail "Backup failed: mapped source does not exist ($source_dir) from $SNAPSHOT_MAP_FILE line $lineno"
            fi

            backup_label="$(normalize_backup_label "$backup_label")"
            if [ -n "${seen_labels[$backup_label]:-}" ]; then
                validation_fail "Backup failed: duplicate backup label '$backup_label' in $SNAPSHOT_MAP_FILE"
            fi

            seen_labels["$backup_label"]=1
            BACKUP_SOURCES+=("$source_dir")
            BACKUP_LABELS+=("$backup_label")
        done < "$SNAPSHOT_MAP_FILE"

        if [ "${#BACKUP_SOURCES[@]}" -eq 0 ]; then
            validation_fail "Backup failed: no mappings found in $SNAPSHOT_MAP_FILE"
        fi

        return 0
    fi

    if [ ! -d "$SOURCE_DIR" ]; then
        validation_fail "Backup failed: SOURCE_DIR does not exist ($SOURCE_DIR)"
    fi

    BACKUP_SOURCES+=("$SOURCE_DIR")
    BACKUP_LABELS+=("$(normalize_backup_label "$BACKUP_LABEL")")
}

validate_inputs() {
    case "$SNAPSHOT_INTERVAL" in
        daily|weekly|monthly|yearly)
            ;;
        *)
            validation_fail "Invalid SNAPSHOT_INTERVAL '$SNAPSHOT_INTERVAL' (expected: daily|weekly|monthly|yearly)"
            ;;
    esac

    for value in "$RETAIN_DAILY" "$RETAIN_WEEKLY" "$RETAIN_MONTHLY" "$RETAIN_YEARLY"; do
        if ! is_non_negative_int "$value"; then
            validation_fail "Retention values must be non-negative integers. Current values: daily=$RETAIN_DAILY weekly=$RETAIN_WEEKLY monthly=$RETAIN_MONTHLY yearly=$RETAIN_YEARLY"
        fi
    done

    if [ "$RETAIN_DAILY" -eq 0 ] && [ "$RETAIN_WEEKLY" -eq 0 ] && [ "$RETAIN_MONTHLY" -eq 0 ] && [ "$RETAIN_YEARLY" -eq 0 ]; then
        validation_fail "At least one retain count must be greater than 0."
    fi

    case "$SNAPSHOT_INTERVAL" in
        daily)
            if [ "$RETAIN_DAILY" -eq 0 ]; then
                validation_fail "SNAPSHOT_INTERVAL=daily but RETAIN_DAILY=0. Increase RETAIN_DAILY or change interval."
            fi
            ;;
        weekly)
            if [ "$RETAIN_WEEKLY" -eq 0 ]; then
                validation_fail "SNAPSHOT_INTERVAL=weekly but RETAIN_WEEKLY=0. Increase RETAIN_WEEKLY or change interval."
            fi
            ;;
        monthly)
            if [ "$RETAIN_MONTHLY" -eq 0 ]; then
                validation_fail "SNAPSHOT_INTERVAL=monthly but RETAIN_MONTHLY=0. Increase RETAIN_MONTHLY or change interval."
            fi
            ;;
        yearly)
            if [ "$RETAIN_YEARLY" -eq 0 ]; then
                validation_fail "SNAPSHOT_INTERVAL=yearly but RETAIN_YEARLY=0. Increase RETAIN_YEARLY or change interval."
            fi
            ;;
    esac

    load_backup_targets
}

render_rsnapshot_config() {
    mkdir -p "$(dirname "$RSNAPSHOT_CONFIG")"
    mkdir -p "$SNAPSHOT_ROOT"

    cat >"$RSNAPSHOT_CONFIG" <<EOF
config_version	1.2
snapshot_root	${SNAPSHOT_ROOT%/}/
no_create_root	0
cmd_cp	/bin/cp
cmd_rm	/bin/rm
cmd_rsync	/usr/bin/rsync
cmd_logger	/usr/bin/logger
verbose	2
loglevel	4
logfile	$DETAIL_LOG_FILE
lockfile	$RSNAPSHOT_LOCK_FILE
stop_on_stale_lockfile	1
rsync_short_args	-a
rsync_long_args	$RSYNC_LONG_ARGS
link_dest	1
EOF

    if [ -n "$EXCLUDE_FILE" ]; then
        if [ -f "$EXCLUDE_FILE" ]; then
            printf 'exclude_file\t%s\n' "$EXCLUDE_FILE" >>"$RSNAPSHOT_CONFIG"
        else
            # Never skip a backup over a missing optimization; just make it visible.
            log_msg "WARNING: exclude file $EXCLUDE_FILE not found; backing up without excludes."
            logger -t besedy-backup "Exclude file missing: $EXCLUDE_FILE"
        fi
    fi

    append_retain_if_enabled daily "$RETAIN_DAILY"
    append_retain_if_enabled weekly "$RETAIN_WEEKLY"
    append_retain_if_enabled monthly "$RETAIN_MONTHLY"
    append_retain_if_enabled yearly "$RETAIN_YEARLY"

    local idx=0
    for idx in "${!BACKUP_SOURCES[@]}"; do
        printf 'backup\t%s/\t%s\n' "${BACKUP_SOURCES[$idx]%/}" "${BACKUP_LABELS[$idx]}" >>"$RSNAPSHOT_CONFIG"
    done
}

fail_and_alert() {
    local rc="$1"
    local message="$2"
    local subject="$3"

    log_msg "$message"
    send_alert "$subject" "$message"
    exit "$rc"
}

run_rsnapshot() {
    local rsnapshot_bin
    rsnapshot_bin="$(command -v rsnapshot || true)"
    if [ -z "$rsnapshot_bin" ]; then
        fail_and_alert 1 "Backup failed: rsnapshot is not installed (command not found)." "[Besedy] Rsnapshot backup FAILED"
    fi

    log_msg "Validating rsnapshot config ($RSNAPSHOT_CONFIG)"
    set +e
    "$rsnapshot_bin" -c "$RSNAPSHOT_CONFIG" configtest >>"$LOG_FILE" 2>&1
    local config_rc=$?
    set -e
    if [ "$config_rc" -ne 0 ]; then
        fail_and_alert "$config_rc" "rsnapshot configtest failed with exit code $config_rc. Check $LOG_FILE." "[Besedy] Rsnapshot backup FAILED (configtest rc=$config_rc)"
    fi

    local cmd=("$rsnapshot_bin" -c "$RSNAPSHOT_CONFIG")
    local detail_log_start_line
    detail_log_start_line="$(get_file_line_count "$DETAIL_LOG_FILE")"
    if [ "${RSNAPSHOT_DRY_RUN:-0}" = "1" ]; then
        cmd+=(-t)
        log_msg "Running rsnapshot in test mode (RSNAPSHOT_DRY_RUN=1)"
    fi
    cmd+=("$SNAPSHOT_INTERVAL")

    if [ -n "$SNAPSHOT_MAP_FILE" ]; then
        log_msg "Starting rsnapshot interval '$SNAPSHOT_INTERVAL' (targets=${#BACKUP_SOURCES[@]}, map_file=$SNAPSHOT_MAP_FILE, snapshot_root=$SNAPSHOT_ROOT)"
    else
        log_msg "Starting rsnapshot interval '$SNAPSHOT_INTERVAL' (source=$SOURCE_DIR, snapshot_root=$SNAPSHOT_ROOT, label=${BACKUP_LABELS[0]})"
    fi
    set +e
    local output
    output=$("${cmd[@]}" 2>&1)
    local rc=$?
    set -e

    if [ -n "$output" ]; then
        printf '%s\n' "$output" >>"$LOG_FILE"
    fi

    local rsync_diagnostics
    rsync_diagnostics="$(extract_rsync_diagnostics "$detail_log_start_line")"
    if [ -n "$rsync_diagnostics" ]; then
        log_msg "Detailed rsync diagnostics from $DETAIL_LOG_FILE:"
        printf '%s\n' "$rsync_diagnostics" >>"$LOG_FILE"
    fi

    if [ "$rc" -eq 2 ]; then
        local warnings
        warnings=$(printf '%s\n' "$output" | grep -i 'WARNING' || true)
        log_msg "rsnapshot interval '$SNAPSHOT_INTERVAL' completed with warnings (exit code 2)."
        local body
        body="rsnapshot interval '$SNAPSHOT_INTERVAL' completed with warnings (exit code 2)."
        body+=$'\n\nWarnings:\n'"${warnings:-No specific warnings captured.}"
        body+=$'\n\nRsync diagnostics:\n'"${rsync_diagnostics:-No detailed rsync diagnostics captured.}"
        body+=$'\n\nCheck '"$LOG_FILE"' and '"$DETAIL_LOG_FILE"' for details.'
        send_alert "[Besedy] Rsnapshot backup completed with warnings" "$body"
        logger -t besedy-backup "rsnapshot interval '$SNAPSHOT_INTERVAL' completed with warnings (rc=2)"
    elif [ "$rc" -ne 0 ]; then
        fail_and_alert "$rc" "rsnapshot interval '$SNAPSHOT_INTERVAL' failed with exit code $rc. Check $LOG_FILE and $DETAIL_LOG_FILE." "[Besedy] Rsnapshot backup FAILED (rc=$rc)"
    else
        log_msg "rsnapshot interval '$SNAPSHOT_INTERVAL' completed successfully."
        logger -t besedy-backup "rsnapshot interval '$SNAPSHOT_INTERVAL' succeeded"
    fi
}

run_remote_sync() {
    if [ "$ENABLE_REMOTE_SYNC" != "1" ]; then
        log_msg "Remote sync disabled (ENABLE_REMOTE_SYNC=$ENABLE_REMOTE_SYNC)."
        return 0
    fi

    if [ -z "$SYNC_TARGET" ]; then
        fail_and_alert 1 "Remote sync enabled but SYNC_TARGET is empty." "[Besedy] Snapshot sync FAILED"
    fi

    if [ ! -f "$PASSWORD_FILE" ]; then
        fail_and_alert 1 "Remote sync enabled but password file missing ($PASSWORD_FILE)." "[Besedy] Snapshot sync FAILED"
    fi

    local sync_cmd=(
        /usr/bin/rsync
        -aH
        --delete
        --no-o
        --no-g
        --stats
        --human-readable
        --password-file="$PASSWORD_FILE"
        "${SNAPSHOT_ROOT%/}/"
        "$SYNC_TARGET"
    )

    if [ "${RSYNC_DRY_RUN:-0}" = "1" ]; then
        sync_cmd=(/usr/bin/rsync --dry-run "${sync_cmd[@]:1}")
        log_msg "Running remote snapshot sync in dry-run mode (RSYNC_DRY_RUN=1)"
    fi

    log_msg "Starting remote snapshot sync to $SYNC_TARGET"
    local attempt_start rc attempt_minutes
    attempt_start="$(date +%s)"
    set +e
    "${sync_cmd[@]}" >>"$LOG_FILE" 2>&1
    rc=$?
    set -e
    attempt_minutes=$(( ($(date +%s) - attempt_start) / 60 ))

    if [ "$rc" -ne 0 ] && [[ " $SYNC_RETRY_CODES " == *" $rc "* ]] \
        && [ "$attempt_minutes" -lt "$SYNC_RETRY_MAX_FIRST_ATTEMPT_MINUTES" ]; then
        log_msg "Remote snapshot sync failed with exit code $rc after ${attempt_minutes} min; retrying once in ${SYNC_RETRY_DELAY_SECONDS}s."
        sleep "$SYNC_RETRY_DELAY_SECONDS"
        log_msg "Starting remote snapshot sync to $SYNC_TARGET (retry)"
        set +e
        "${sync_cmd[@]}" >>"$LOG_FILE" 2>&1
        rc=$?
        set -e
    fi

    if [ "$rc" -ne 0 ]; then
        fail_and_alert "$rc" "Remote snapshot sync failed with exit code $rc. Check $LOG_FILE." "[Besedy] Snapshot sync FAILED (rc=$rc)"
    fi

    log_msg "Remote snapshot sync completed successfully."
    logger -t besedy-backup "Snapshot sync succeeded (target=$SYNC_TARGET)"
}

run_snapshot_hook() {
    local hook="$1" phase="$2" rc
    [ -n "$hook" ] && [ "$SNAPSHOT_INTERVAL" = daily ] || return 0
    if [ "${RSNAPSHOT_DRY_RUN:-0}" = 1 ] || [ "${RSYNC_DRY_RUN:-0}" = 1 ]; then
        log_msg "Skipping $phase hook in dry-run mode."
        return 0
    fi
    log_msg "Starting $phase hook: $hook"
    set +e
    bash "$hook" "$phase" >>"$LOG_FILE" 2>&1
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        HOOK_FAILED=1
        log_msg "$phase hook FAILED (rc=$rc); ordinary data backup is not disabled."
        send_alert "[Besedy] Database backup $phase FAILED" \
            "Database backup hook failed (rc=$rc). Check $LOG_FILE for details."
    else
        log_msg "$phase hook completed successfully."
    fi
}

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$DETAIL_LOG_FILE")"
rotate_log_if_needed "$LOG_FILE" "$MAX_LOG_BYTES"
rotate_log_if_needed "$DETAIL_LOG_FILE" "$MAX_DETAIL_LOG_BYTES"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log_msg "Another backup run is already in progress; skipping."
    logger -t besedy-backup "Skipped run due to active lock file $LOCK_FILE"
    exit 0
fi

validate_inputs
render_rsnapshot_config
export SNAPSHOT_INTERVAL SNAPSHOT_ROOT SYNC_TARGET ENABLE_REMOTE_SYNC
run_snapshot_hook "$BEFORE_SNAPSHOT_HOOK" before
run_rsnapshot
run_remote_sync
run_snapshot_hook "$AFTER_SYNC_HOOK" after
exit "$HOOK_FAILED"
