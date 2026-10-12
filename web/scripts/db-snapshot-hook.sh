#!/usr/bin/env bash
# Daily rsnapshot hooks and a read-only check of the NAS database recovery point.
# before/after are called by back_up.sh while it holds its snapshot lock.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
OPS_ENV_FILE="$(bash "$PROJECT_DIR/scripts/resolve_ops_env_file.sh")"
if [ -f "$OPS_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OPS_ENV_FILE"
    set +a
fi

: "${BACKUP_DIR:?Set BACKUP_DIR in ops.env}"
: "${DB_BACKUP_REMOTE_TARGET:?Set DB_BACKUP_REMOTE_TARGET in ops.env}"
: "${DB_BACKUP_PASSWORD_FILE:?Set DB_BACKUP_PASSWORD_FILE in ops.env}"
DB_BACKUP_MAX_AGE_HOURS="${DB_BACKUP_MAX_AGE_HOURS:-24}"
PENDING_FILE="$BACKUP_DIR/.nas-pending.tsv"
VERIFIED_FILE="$BACKUP_DIR/.nas-verified.tsv"
phase="${1:-check}"
download_dir=""
receipt_tmp=""

cleanup() {
    if [ -n "$download_dir" ]; then
        rm -f -- "$download_dir/dump.sql.gz"
        rmdir -- "$download_dir"
    fi
    if [ -n "$receipt_tmp" ]; then
        rm -f -- "$receipt_tmp"
    fi
}
trap cleanup EXIT

fail() { echo "DB NAS backup FAILED: $*" >&2; exit 1; }
[[ "$DB_BACKUP_MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] || fail "Invalid maximum dump age"
[ -d "$BACKUP_DIR" ] || fail "Backup directory missing: $BACKUP_DIR"
[ -f "$DB_BACKUP_PASSWORD_FILE" ] || fail "NAS password file missing"

write_receipt() {
    local destination="$1"
    receipt_tmp="$(mktemp "$BACKUP_DIR/.nas-receipt.XXXXXX")"
    printf '%s\t%s\t%s\t%s\t%s\n' "$dump_name" "$dump_epoch" "$checksum" \
        "$verified_epoch" "$DB_BACKUP_REMOTE_TARGET" >"$receipt_tmp"
    mv -f -- "$receipt_tmp" "$destination"
    receipt_tmp=""
}

read_receipt() {
    local file="$1" saved_target
    [ -f "$file" ] || fail "Missing receipt: $file"
    IFS=$'\t' read -r dump_name dump_epoch checksum verified_epoch saved_target <"$file"
    [[ "$dump_name" =~ ^besedy_[0-9]{8}_[0-9]{6}\.sql\.gz$ ]] || fail "Invalid dump name in receipt"
    [[ "$dump_epoch" =~ ^[0-9]+$ && "$verified_epoch" =~ ^[0-9]+$ ]] || fail "Invalid receipt timestamps"
    [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid receipt checksum"
    [ "$saved_target" = "$DB_BACKUP_REMOTE_TARGET" ] || fail "NAS target changed since receipt was written"
}

verify_remote() {
    local actual_checksum age_seconds
    age_seconds=$(( $(date +%s) - dump_epoch ))
    [ "$age_seconds" -ge 0 ] || fail "Dump timestamp is in the future"
    [ "$age_seconds" -le "$(( DB_BACKUP_MAX_AGE_HOURS * 3600 ))" ] \
        || fail "NAS recovery point is overdue: $(( age_seconds / 3600 ))h old (limit ${DB_BACKUP_MAX_AGE_HOURS}h)"
    download_dir="$(mktemp -d "${TMPDIR:-/tmp}/besedy-db-nas-check.XXXXXX")"
    remote_file="${DB_BACKUP_REMOTE_TARGET%/}/daily.0/state/db_dumps/$dump_name"
    rsync -a --no-o --no-g --timeout=180 --password-file="$DB_BACKUP_PASSWORD_FILE" \
        "$remote_file" "$download_dir/dump.sql.gz"
    gzip -t "$download_dir/dump.sql.gz"
    actual_checksum="$(sha256sum "$download_dir/dump.sql.gz")"
    [ "${actual_checksum%% *}" = "$checksum" ] || fail "Retrieved NAS dump has a different checksum"
    echo "DB NAS backup OK: dump=$dump_name age_seconds=$age_seconds sha256=$checksum remote=$remote_file"
}

case "$phase" in
    before)
        [ "${SNAPSHOT_INTERVAL:-daily}" = daily ] || fail "Dump hook requires a daily snapshot"
        [ "${SYNC_TARGET:-}" = "$DB_BACKUP_REMOTE_TARGET" ] || fail "Snapshot sync target differs from database NAS target"
        [ "${ENABLE_REMOTE_SYNC:-1}" = 1 ] || fail "Remote sync is disabled"
        # Never let an earlier pending receipt disguise a failed new attempt.
        rm -f -- "$PENDING_FILE"
        dump_epoch="$(date +%s)"
        dump_name="besedy_$(date -u -d "@$dump_epoch" +%Y%m%d_%H%M%S).sql.gz"
        # Verify the Compose service writes into the same directory the map backs up.
        mount_source="$(bash "$PROJECT_DIR/scripts/run_web_compose.sh" production config --format json \
            | jq -r '.services.backup.volumes[] | select(.target == "/backups") | .source')"
        [ "$(realpath -e "$mount_source")" = "$(realpath -e "$BACKUP_DIR")" ] \
            || fail "Compose BACKUP_DIR differs from ops.env"
        timeout 900 bash "$PROJECT_DIR/scripts/run_web_compose.sh" production run --rm --no-deps \
            -e "BACKUP_FILENAME=$dump_name" backup
        [ -s "$BACKUP_DIR/$dump_name" ] || fail "Fresh dump was not created"
        gzip -t "$BACKUP_DIR/$dump_name"
        checksum="$(sha256sum "$BACKUP_DIR/$dump_name")"
        checksum="${checksum%% *}"
        verified_epoch=0
        write_receipt "$PENDING_FILE"
        echo "Fresh DB dump ready: $dump_name sha256=$checksum"
        ;;
    after)
        [ "${ENABLE_REMOTE_SYNC:-1}" = 1 ] || fail "Remote sync is disabled"
        [ "${SYNC_TARGET:-}" = "$DB_BACKUP_REMOTE_TARGET" ] || fail "Snapshot sync target differs from database NAS target"
        read_receipt "$PENDING_FILE"
        # Also detects a skipped snapshot or a missing/excluded dump in the map.
        snapshot_dump="${SNAPSHOT_ROOT:?}/daily.0/state/db_dumps/$dump_name"
        [ -s "$snapshot_dump" ] || fail "Fresh dump missing from daily snapshot"
        snapshot_checksum="$(sha256sum "$snapshot_dump")"
        [ "${snapshot_checksum%% *}" = "$checksum" ] || fail "Local snapshot dump differs from fresh dump"
        verify_remote
        verified_epoch="$(date +%s)"
        write_receipt "$VERIFIED_FILE"
        rm -f -- "$PENDING_FILE"
        ;;
    check)
        read_receipt "$VERIFIED_FILE"
        [ "$verified_epoch" -gt 0 ] || fail "Dump has not been verified on NAS"
        verify_remote
        ;;
    *) fail "Usage: $0 {before|after|check}" ;;
esac
