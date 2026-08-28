#!/bin/bash
# Weekly activity report for Besedy
#
# Installation (user crontab):
#   crontab -e
#   # Add: 30 6 * * 0 REPORT_EMAIL="you@example.com" /path/to/weekly-report.sh 2>&1 | logger -t besedy-weekly
#
# Configuration (environment variables):
#   REPORT_EMAIL - Email address for reports (requires sendmail/msmtp)
#   BESEDY_COMPOSE_DIR - Path to web directory (default: auto-detected from the script's location)
#   REPORT_WINDOW_DAYS - Number of days to aggregate (default: 7)
#   PER_USER_BREAKDOWN_LIMIT - Max users in the audio breakdown (default: 20)
#   HOST_BACKUP_MAX_AGE_HOURS - Freshness threshold for host snapshot checks (default: 30)
#   THRESHOLD_FAILED_LOGIN - Alert threshold for failed logins (default: 5 * REPORT_WINDOW_DAYS)
#   THRESHOLD_ACCESS_DENIED - Alert threshold for access denied (default: 10 * REPORT_WINDOW_DAYS)

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
REPORT_EMAIL="${REPORT_EMAIL:-}"
TAG="${REPORT_LOG_TAG:-besedy-weekly}"
REPORT_WINDOW_DAYS="${REPORT_WINDOW_DAYS:-7}"
PER_USER_BREAKDOWN_LIMIT="${PER_USER_BREAKDOWN_LIMIT:-20}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

compose_cmd() {
    "$PROJECT_DIR/scripts/run_web_compose.sh" production "$@"
}
OPS_ENV_FILE="$("$PROJECT_DIR/scripts/resolve_ops_env_file.sh")"
if [ -f "$OPS_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$OPS_ENV_FILE"
    set +a
fi

: "${PROJECT_SNAPSHOT_ROOT:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
: "${EXTRA_SNAPSHOT_ROOT:?is not set — add it to ops.env (see web/setup/backup/ops.env.example)}"
PROJECT_BACKUP_LOG_FILE="${PROJECT_BACKUP_LOG_FILE:-${PROJECT_LOG_FILE:-}}"
EXTRA_BACKUP_LOG_FILE="${EXTRA_BACKUP_LOG_FILE:-${EXTRA_LOG_FILE:-}}"
: "${PROJECT_BACKUP_LOG_FILE:?is not set — add PROJECT_LOG_FILE to ops.env (see web/setup/backup/ops.env.example)}"
: "${EXTRA_BACKUP_LOG_FILE:?is not set — add EXTRA_LOG_FILE to ops.env (see web/setup/backup/ops.env.example)}"
EXTRA_MAP_FILE="${EXTRA_MAP_FILE:-$COMPOSE_DIR/setup/backup/besedy-extra.paths}"
HOST_BACKUP_MAX_AGE_HOURS="${HOST_BACKUP_MAX_AGE_HOURS:-30}"

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

if ! is_positive_int "$REPORT_WINDOW_DAYS"; then
    echo "REPORT_WINDOW_DAYS must be a positive integer, got: $REPORT_WINDOW_DAYS" >&2
    exit 1
fi

if ! is_positive_int "$PER_USER_BREAKDOWN_LIMIT"; then
    echo "PER_USER_BREAKDOWN_LIMIT must be a positive integer, got: $PER_USER_BREAKDOWN_LIMIT" >&2
    exit 1
fi

DEFAULT_FAILED_LOGIN_THRESHOLD=$((5 * REPORT_WINDOW_DAYS))
DEFAULT_ACCESS_DENIED_THRESHOLD=$((10 * REPORT_WINDOW_DAYS))
THRESHOLD_FAILED_LOGIN="${THRESHOLD_FAILED_LOGIN:-$DEFAULT_FAILED_LOGIN_THRESHOLD}"
THRESHOLD_ACCESS_DENIED="${THRESHOLD_ACCESS_DENIED:-$DEFAULT_ACCESS_DENIED_THRESHOLD}"

if ! is_positive_int "$THRESHOLD_FAILED_LOGIN"; then
    echo "THRESHOLD_FAILED_LOGIN must be a positive integer, got: $THRESHOLD_FAILED_LOGIN" >&2
    exit 1
fi

if ! is_positive_int "$THRESHOLD_ACCESS_DENIED"; then
    echo "THRESHOLD_ACCESS_DENIED must be a positive integer, got: $THRESHOLD_ACCESS_DENIED" >&2
    exit 1
fi

REPORT_WINDOW_SQL="${REPORT_WINDOW_DAYS} days"

# Function to run database query
db_query() {
    compose_cmd exec -T db psql -U besedy_app -d besedy -tA -c "$1" 2>/dev/null || echo "0"
}

# Run backup health check without triggering alert emails; return a report-friendly summary.
backup_health_summary() {
    local backup_script="$SCRIPT_DIR/backup-health-check.sh"
    local output=""

    if [ ! -x "$backup_script" ]; then
        echo "UNKNOWN|backup-health-check.sh not found or not executable: $backup_script"
        return 0
    fi

    if output="$(ALERT_EMAIL="" REPORT_EMAIL="" BESEDY_COMPOSE_DIR="$COMPOSE_DIR" "$backup_script" 2>&1)"; then
        output="$(echo "$output" | tail -n1)"
        echo "OK|$output"
        return 0
    fi

    echo "FAILED|$output"
}

host_backup_health_summary() {
    local host_backup_script="$SCRIPT_DIR/host-backup-health-check.sh"
    local output=""

    if [ ! -x "$host_backup_script" ]; then
        echo "UNKNOWN|host-backup-health-check.sh not found or not executable: $host_backup_script"
        return 0
    fi

    if output="$(
        ALERT_EMAIL="" \
        REPORT_EMAIL="" \
        BESEDY_COMPOSE_DIR="$COMPOSE_DIR" \
        PROJECT_SNAPSHOT_ROOT="$PROJECT_SNAPSHOT_ROOT" \
        EXTRA_SNAPSHOT_ROOT="$EXTRA_SNAPSHOT_ROOT" \
        PROJECT_LOG_FILE="$PROJECT_BACKUP_LOG_FILE" \
        EXTRA_LOG_FILE="$EXTRA_BACKUP_LOG_FILE" \
        EXTRA_MAP_FILE="$EXTRA_MAP_FILE" \
        MAX_AGE_HOURS="$HOST_BACKUP_MAX_AGE_HOURS" \
        REMOTE_SYNC_MAX_AGE_HOURS="$HOST_BACKUP_MAX_AGE_HOURS" \
        "$host_backup_script" 2>&1
    )"; then
        echo "OK|$output"
        return 0
    fi

    echo "FAILED|$output"
}

# Collect metrics for the configured report window.
echo "Collecting weekly metrics..."

# Login statistics
LOGINS=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action = 'LOGIN' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
FAILED_LOGINS=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action = 'LOGIN_FAILED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")

# Active users (distinct users who logged in during the report window)
ACTIVE_USERS=$(db_query "SELECT COUNT(DISTINCT user_id) FROM audit_log WHERE action = 'LOGIN' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")

# Audio activity - grouped metrics
# Count plays (listening sessions) = when user switches to different audio
# Sequence 1,1,1,3,3,3,2,2,1,1 = 4 plays, not 10 events or 3 unique tracks
AUDIO_PLAYS=$(db_query "
WITH ordered_events AS (
  SELECT user_id, resource_id,
         LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev
  FROM audit_log
  WHERE action = 'AUDIO_STREAMED'
    AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
    AND user_id IS NOT NULL AND resource_id IS NOT NULL
)
SELECT COUNT(*) FROM ordered_events
WHERE resource_id != prev OR prev IS NULL
")
AUDIO_UNIQUE_TRACKS=$(db_query "SELECT COUNT(DISTINCT resource_id) FROM audit_log WHERE action = 'AUDIO_STREAMED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
AUDIO_UNIQUE_USERS=$(db_query "SELECT COUNT(DISTINCT user_id) FROM audit_log WHERE action = 'AUDIO_STREAMED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
AUDIO_DOWNLOADS=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action = 'AUDIO_DOWNLOADED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
TRANSCRIPT_DOWNLOADS=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action = 'TRANSCRIPT_DOWNLOADED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")

# MCP tool activity. The usage table intentionally contains no raw search text,
# transcript content, bearer tokens, or complete tool arguments/responses.
MCP_CALLS=$(db_query "SELECT COUNT(*) FROM mcp_tool_invocation WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_UNIQUE_USERS=$(db_query "SELECT COUNT(DISTINCT user_id) FROM mcp_tool_invocation WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_UNIQUE_CLIENTS=$(db_query "SELECT COUNT(DISTINCT client_id) FROM mcp_tool_invocation WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_SUCCESSES=$(db_query "SELECT COUNT(*) FROM mcp_tool_invocation WHERE outcome = 'SUCCESS' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_ERRORS=$(db_query "SELECT COUNT(*) FROM mcp_tool_invocation WHERE outcome = 'ERROR' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_DENIALS=$(db_query "SELECT COUNT(*) FROM mcp_tool_invocation WHERE outcome = 'DENIED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
MCP_RETURNED_TEXT_CHARS=$(db_query "SELECT COALESCE(SUM(returned_text_chars), 0) FROM mcp_tool_invocation WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")

MCP_BY_TOOL=$(db_query "
SELECT tool_name || ': ' || COUNT(*) ||
       CASE WHEN COUNT(*) = 1 THEN ' call' ELSE ' calls' END ||
       ' by ' || COUNT(DISTINCT user_id) ||
       CASE WHEN COUNT(DISTINCT user_id) = 1 THEN ' user' ELSE ' users' END ||
       CASE WHEN COUNT(*) FILTER (WHERE outcome != 'SUCCESS') > 0
         THEN ' (' || COUNT(*) FILTER (WHERE outcome != 'SUCCESS') || ' unsuccessful)'
         ELSE ''
       END
FROM mcp_tool_invocation
WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
GROUP BY tool_name
ORDER BY COUNT(*) DESC, tool_name ASC
" | sed 's/^/  • /')

MCP_BY_USER=$(db_query "
SELECT COALESCE(u.email, invocation.user_id, 'deleted user') || ': ' ||
       COUNT(*) || CASE WHEN COUNT(*) = 1 THEN ' call' ELSE ' calls' END ||
       ' across ' || COUNT(DISTINCT tool_name) ||
       CASE WHEN COUNT(DISTINCT tool_name) = 1 THEN ' tool' ELSE ' tools' END
FROM mcp_tool_invocation invocation
LEFT JOIN users u ON u.id = invocation.user_id
WHERE invocation.created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
GROUP BY invocation.user_id, u.email
ORDER BY COUNT(*) DESC, COALESCE(LOWER(u.email), invocation.user_id, 'deleted user') ASC
LIMIT $PER_USER_BREAKDOWN_LIMIT
" | sed 's/^/  • /')

MCP_BY_CLIENT=$(db_query "
SELECT COALESCE(MAX(client_name), client_id) || ': ' || COUNT(*) ||
       CASE WHEN COUNT(*) = 1 THEN ' call' ELSE ' calls' END ||
       ' by ' || COUNT(DISTINCT user_id) ||
       CASE WHEN COUNT(DISTINCT user_id) = 1 THEN ' user' ELSE ' users' END
FROM mcp_tool_invocation
WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
GROUP BY client_id
ORDER BY COUNT(*) DESC, client_id ASC
LIMIT $PER_USER_BREAKDOWN_LIMIT
" | sed 's/^/  • /')

# Per-user audio breakdown (top N users by plays)
AUDIO_PER_USER=$(db_query "
WITH ordered_events AS (
  SELECT user_id, resource_id,
         LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev
  FROM audit_log
  WHERE action = 'AUDIO_STREAMED'
    AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
    AND user_id IS NOT NULL AND resource_id IS NOT NULL
),
plays AS (
  SELECT user_id FROM ordered_events
  WHERE resource_id != prev OR prev IS NULL
),
user_plays AS (
  SELECT user_id, COUNT(*) as play_count FROM plays GROUP BY user_id
)
SELECT COALESCE(u.email, 'anonymous') || ': ' || up.play_count ||
       CASE WHEN up.play_count = 1 THEN ' play' ELSE ' plays' END
FROM user_plays up
LEFT JOIN users u ON up.user_id = u.id
ORDER BY up.play_count DESC, COALESCE(LOWER(u.email), 'anonymous') ASC
LIMIT $PER_USER_BREAKDOWN_LIMIT
" | sed 's/^/  • /')

# Admin activity
PORTAL_ADMISSIONS_ADDED=$(db_query "
SELECT COUNT(*)
FROM audit_log
WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
  AND (
    action::text = 'PORTAL_ADMISSION_CREATED'
    OR (
      action::text = 'INVITATION_CREATED'
      AND NULLIF(details->>'catalogId', '') IS NULL
    )
  )
")
PENDING_GRANTS_ADDED=$(db_query "
SELECT COUNT(*)
FROM audit_log
WHERE created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
  AND (
    action::text = 'PENDING_CATALOG_GRANT_CREATED'
    OR (
      action::text = 'INVITATION_CREATED'
      AND NULLIF(details->>'catalogId', '') IS NOT NULL
    )
  )
")
ROLE_CHANGES=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action IN ('ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED') AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
ACCESS_GRANTS=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action IN ('CATALOG_ACCESS_GRANTED', 'CATALOG_ACCESS_UPDATED', 'CATALOG_ACCESS_REVOKED') AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")

# Security events
ACCESS_DENIED=$(db_query "SELECT COUNT(*) FROM audit_log WHERE action = 'ACCESS_DENIED' AND created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'")
DENIED_ACCESS_EMAILS=$(db_query "
SELECT email || ': ' || denials ||
       CASE WHEN denials = 1 THEN ' denial' ELSE ' denials' END
FROM (
  SELECT
    COALESCE(
      NULLIF(LOWER(TRIM(u.email)), ''),
      NULLIF(LOWER(TRIM(al.details->>'email')), ''),
      'unknown'
    ) AS email,
    COUNT(*) AS denials
  FROM audit_log al
  LEFT JOIN users u ON al.user_id = u.id
  WHERE al.action = 'ACCESS_DENIED'
    AND al.created_at > NOW() - INTERVAL '$REPORT_WINDOW_SQL'
  GROUP BY 1
) denied
ORDER BY denials DESC, email ASC
LIMIT 10
" | sed 's/^/  • /')

DENIED_ACCESS_EMAILS_BLOCK=""
if [ -n "$DENIED_ACCESS_EMAILS" ]; then
    DENIED_ACCESS_EMAILS_BLOCK="$DENIED_ACCESS_EMAILS"
elif [ "$ACCESS_DENIED" -gt 0 ]; then
    DENIED_ACCESS_EMAILS_BLOCK="  • Emails unavailable (anonymous or missing user records)"
fi

SUPERADMIN_COUNT=$(db_query "SELECT COUNT(*) FROM users WHERE is_superadmin = true")

# Total users
TOTAL_USERS=$(db_query "SELECT COUNT(*) FROM users WHERE status = 'ACTIVE'")

# Backup health
BACKUP_HEALTH_RESULT="$(backup_health_summary)"
BACKUP_HEALTH_STATUS="${BACKUP_HEALTH_RESULT%%|*}"
BACKUP_HEALTH_DETAILS="${BACKUP_HEALTH_RESULT#*|}"
HOST_BACKUP_RESULT="$(host_backup_health_summary)"
HOST_BACKUP_STATUS="${HOST_BACKUP_RESULT%%|*}"
HOST_BACKUP_DETAILS="${HOST_BACKUP_RESULT#*|}"

DB_BACKUP_DETAILS_FORMATTED="    ${BACKUP_HEALTH_DETAILS//$'\n'/$'\n    '}"
HOST_BACKUP_DETAILS_FORMATTED="    ${HOST_BACKUP_DETAILS//$'\n'/$'\n    '}"

# Check for alerts
ALERTS=""
if [ "$FAILED_LOGINS" -gt "$THRESHOLD_FAILED_LOGIN" ]; then
    ALERTS="${ALERTS}  [!] $FAILED_LOGINS failed login attempts (threshold: $THRESHOLD_FAILED_LOGIN)\n"
fi
if [ "$ACCESS_DENIED" -gt "$THRESHOLD_ACCESS_DENIED" ]; then
    ALERTS="${ALERTS}  [!] $ACCESS_DENIED access denied events (threshold: $THRESHOLD_ACCESS_DENIED)\n"
fi
if [ "$ROLE_CHANGES" -gt 0 ]; then
    ALERTS="${ALERTS}  [i] $ROLE_CHANGES admin role changes\n"
fi

# Build report
REPORT="BESEDY WEEKLY REPORT - $(date +%Y-%m-%d)
=====================================

ACTIVITY SUMMARY (Last ${REPORT_WINDOW_DAYS} Days)
--------------------------------
Logins:             $LOGINS successful, $FAILED_LOGINS failed
Active users:       $ACTIVE_USERS (of $TOTAL_USERS total)

AUDIO ACTIVITY
--------------
Plays:              $AUDIO_PLAYS (by $AUDIO_UNIQUE_USERS users)
Unique tracks:      $AUDIO_UNIQUE_TRACKS
Downloads:          $AUDIO_DOWNLOADS
Transcript exports: $TRANSCRIPT_DOWNLOADS
${AUDIO_PER_USER:+
Per-user breakdown:
$AUDIO_PER_USER}

MCP ACTIVITY
------------
Tool calls:          $MCP_CALLS by $MCP_UNIQUE_USERS users
OAuth clients:       $MCP_UNIQUE_CLIENTS
Successful:          $MCP_SUCCESSES
Errors / denials:    $MCP_ERRORS / $MCP_DENIALS
Transcript chars:    $MCP_RETURNED_TEXT_CHARS
${MCP_BY_TOOL:+
Tools:
$MCP_BY_TOOL}
${MCP_BY_USER:+
Top users:
$MCP_BY_USER}
${MCP_BY_CLIENT:+
Clients:
$MCP_BY_CLIENT}

ADMIN ACTIVITY
--------------
Portal admissions:  $PORTAL_ADMISSIONS_ADDED
Pending grants:     $PENDING_GRANTS_ADDED
Role changes:       $ROLE_CHANGES
Access changes:     $ACCESS_GRANTS

SECURITY
--------
Access denied:      $ACCESS_DENIED
${DENIED_ACCESS_EMAILS_BLOCK:+
Emails denied access:
$DENIED_ACCESS_EMAILS_BLOCK}
Superadmins:        $SUPERADMIN_COUNT

BACKUP HEALTH
-------------
Local DB dump health:
  Status:           $BACKUP_HEALTH_STATUS
  Details:
$DB_BACKUP_DETAILS_FORMATTED

Host snapshot coverage:
  Status:           $HOST_BACKUP_STATUS
  Details:
$HOST_BACKUP_DETAILS_FORMATTED
"

if [ -n "$ALERTS" ]; then
    REPORT="${REPORT}
ALERTS
------
$(echo -e "$ALERTS")"
fi

REPORT="${REPORT}
---
Report generated at $(date '+%Y-%m-%d %H:%M:%S %Z')
View detailed logs: cd ${COMPOSE_DIR%/web} && just prod-db
"

# Send email if configured
if [ -n "$REPORT_EMAIL" ]; then
    if ! command -v sendmail >/dev/null 2>&1; then
        logger -t "$TAG" "Failed to send report: sendmail command not found"
        echo "$REPORT"
        exit 1
    fi

    if {
        echo "Subject: [Besedy] Weekly Report - $(date +%Y-%m-%d)"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "$REPORT"
    } | sendmail "$REPORT_EMAIL"; then
        logger -t "$TAG" "Report sent to $REPORT_EMAIL"
    else
        logger -t "$TAG" "Failed to send report to $REPORT_EMAIL via sendmail"
        echo "$REPORT"
        exit 1
    fi
else
    # Output to stdout (for testing or journald capture)
    echo "$REPORT"
    logger -t "$TAG" "Report generated (no email configured)"
fi
