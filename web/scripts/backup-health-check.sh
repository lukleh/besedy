#!/usr/bin/env bash
# Daily health check for production DB backups.

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
ENV_FILE="$("$PROJECT_DIR/scripts/resolve_web_env_file.sh" production)"
ALERT_EMAIL="${ALERT_EMAIL:-${REPORT_EMAIL:-}}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-30}"
MIN_GZIP_SIZE_BYTES="${MIN_GZIP_SIZE_BYTES:-50000}"
MIN_SQL_SIZE_BYTES="${MIN_SQL_SIZE_BYTES:-200000}"
TAG="besedy-backup"

if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

OPS_ENV_FILE="$("$PROJECT_DIR/scripts/resolve_ops_env_file.sh")"
if [ -f "$OPS_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OPS_ENV_FILE"
    set +a
fi

: "${BACKUP_DIR:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"

compose_cmd() {
    "$PROJECT_DIR/scripts/run_web_compose.sh" production "$@"
}

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

failures=()
info=()
tmp_sql=""

cleanup() {
    if [ -n "$tmp_sql" ] && [ -f "$tmp_sql" ]; then
        rm -f "$tmp_sql"
    fi
}
trap cleanup EXIT

if [ ! -d "$BACKUP_DIR" ]; then
    failures+=("Backup directory missing: $BACKUP_DIR")
else
    latest="$(
        find "$BACKUP_DIR" -maxdepth 1 -type f -name 'besedy_[0-9]*_[0-9]*.sql.gz' \
            -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-
    )"

    if [ -z "$latest" ]; then
        failures+=("No automatic backup files found (pattern besedy_YYYYMMDD_HHMMSS.sql.gz)")
    else
        now_epoch="$(date +%s)"
        latest_epoch="$(stat -c %Y "$latest")"
        age_hours="$(( (now_epoch - latest_epoch) / 3600 ))"
        gzip_size="$(stat -c %s "$latest")"
        info+=("latest_backup=$latest")
        info+=("age_hours=$age_hours")
        info+=("gzip_size_bytes=$gzip_size")

        if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
            failures+=("Latest backup is too old: ${age_hours}h (threshold ${MAX_AGE_HOURS}h)")
        fi
        if [ "$gzip_size" -lt "$MIN_GZIP_SIZE_BYTES" ]; then
            failures+=("Latest backup gzip file is too small: ${gzip_size} bytes")
        fi

        if ! gzip -t "$latest" 2>/dev/null; then
            failures+=("gzip integrity check failed for $latest")
        else
            tmp_sql="$(mktemp)"
            if ! gzip -cd "$latest" >"$tmp_sql"; then
                failures+=("Failed to decompress $latest")
            else
                sql_size="$(wc -c <"$tmp_sql")"
                info+=("decompressed_size_bytes=$sql_size")
                if [ "$sql_size" -lt "$MIN_SQL_SIZE_BYTES" ]; then
                    failures+=("Latest backup SQL content is too small: ${sql_size} bytes")
                fi
                if ! grep -q '^COPY public.catalog_entry ' "$tmp_sql"; then
                    failures+=("Expected table data marker missing (COPY public.catalog_entry)")
                fi
            fi
        fi
    fi
fi

backup_cid="$(compose_cmd ps -q backup 2>/dev/null | head -n1 || true)"
if [ -z "$backup_cid" ]; then
    failures+=("Backup service is not running (docker compose service: backup)")
else
    status="$(docker inspect -f '{{.State.Status}}' "$backup_cid" 2>/dev/null || echo unknown)"
    info+=("backup_container_status=$status")
    if [ "$status" != "running" ]; then
        failures+=("Backup service container state is $status")
    fi
fi

if [ "${#failures[@]}" -gt 0 ]; then
    body="Besedy DB backup health check failed on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S %Z').

Failures:
$(printf ' - %s\n' "${failures[@]}")

Context:
$(printf ' - %s\n' "${info[@]}")

Suggested checks:
 - cd $PROJECT_DIR && just prod-status
 - docker logs besedy-production-backup --tail=100
 - ls -lah $BACKUP_DIR"

    send_alert "[Besedy] DB backup health check FAILED" "$body"
    printf '%s\n' "$body"
    exit 1
fi

summary="DB backup health check OK on $(hostname): $(printf '%s; ' "${info[@]}")"
logger -t "$TAG" "$summary"
echo "$summary"
