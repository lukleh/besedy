#!/bin/bash
# Daily security audit check for Besedy
#
# Installation (user crontab):
#   crontab -e
#   # Add: 0 6 * * * ALERT_EMAIL="you@example.com" /path/to/audit-check.sh 2>&1 | logger -t besedy-audit
#
# Configuration (environment variables):
#   ALERT_EMAIL - Email address for alerts (requires sendmail/msmtp)
#   BESEDY_COMPOSE_DIR - Path to web directory (default: auto-detected from the script's location)
#   THRESHOLD_FAILED_LOGIN - Alert threshold for failed logins (default: 5)
#   THRESHOLD_ACCESS_DENIED - Alert threshold for access denied (default: 10)

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
THRESHOLD_FAILED_LOGIN="${THRESHOLD_FAILED_LOGIN:-5}"
THRESHOLD_ACCESS_DENIED="${THRESHOLD_ACCESS_DENIED:-10}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
TAG="${REPORT_LOG_TAG:-besedy-audit}"

compose_cmd() {
    "$PROJECT_DIR/scripts/run_web_compose.sh" production "$@"
}

on_error() {
  local status="$1"
  local line="$2"
  trap - ERR
  local message="Security audit failed at line $line with status $status; no zero-value fallback was used."
  logger -t "$TAG" "$message"
  if [ -n "$ALERT_EMAIL" ] && command -v sendmail >/dev/null 2>&1; then
    {
      echo "Subject: [Besedy] Security audit failed - $(date +%Y-%m-%d)"
      echo "Content-Type: text/plain; charset=utf-8"
      echo ""
      echo "$message"
    } | sendmail "$ALERT_EMAIL" || logger -t "$TAG" "Could not email audit failure to $ALERT_EMAIL"
  fi
  exit "$status"
}
trap 'on_error "$?" "$LINENO"' ERR

DB_CONTAINER_ID="$(compose_cmd ps -q db)"
if [ -z "$DB_CONTAINER_ID" ]; then
  echo "Production database container is not running." >&2
  false
fi

db_query() {
  docker exec -i "$DB_CONTAINER_ID" psql -U besedy_app -d besedy -v ON_ERROR_STOP=1 -tA -c "$1"
}

# Check failed logins in last 24 hours
FAILED=$(db_query "
    SELECT COUNT(*) FROM audit_log
    WHERE action = 'LOGIN_FAILED'
    AND created_at > NOW() - INTERVAL '24 hours'")

# Check access denied events in last 24 hours
DENIED=$(db_query "
    SELECT COUNT(*) FROM audit_log
    WHERE action = 'ACCESS_DENIED'
    AND created_at > NOW() - INTERVAL '24 hours'")

# Check current superadmin count (should rarely change)
SUPERADMINS=$(db_query "SELECT COUNT(*) FROM users WHERE is_superadmin = true")

# Check for recent admin role changes
ROLE_CHANGES=$(db_query "
    SELECT COUNT(*) FROM audit_log
    WHERE action IN ('ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
    AND created_at > NOW() - INTERVAL '24 hours'")

# Build alert message if thresholds exceeded
ALERT=""
if [ "$FAILED" -gt "$THRESHOLD_FAILED_LOGIN" ]; then
  ALERT="${ALERT}- $FAILED failed login attempts (threshold: $THRESHOLD_FAILED_LOGIN)\n"
fi
if [ "$DENIED" -gt "$THRESHOLD_ACCESS_DENIED" ]; then
  ALERT="${ALERT}- $DENIED access denied events (threshold: $THRESHOLD_ACCESS_DENIED)\n"
fi
if [ "$ROLE_CHANGES" -gt 0 ]; then
  ALERT="${ALERT}- $ROLE_CHANGES admin role changes detected\n"
fi

# Send email if alert needed and email configured
if [ -n "$ALERT" ] && [ -n "$ALERT_EMAIL" ]; then
  {
    echo "Subject: [Besedy] Security Alert - $(date +%Y-%m-%d)"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "Security anomalies detected in the last 24 hours:"
    echo ""
    echo -e "$ALERT"
    echo ""
    echo "Current superadmin count: $SUPERADMINS"
    echo ""
    echo "To review audit logs:"
    echo "  cd ${COMPOSE_DIR%/web} && just prod-db"
    echo "  SELECT created_at, action, ip_address, details FROM audit_log WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC;"
  } | sendmail "$ALERT_EMAIL"

  logger -t "$TAG" "Alert sent to $ALERT_EMAIL: $FAILED failed logins, $DENIED access denied, $ROLE_CHANGES role changes"
elif [ -n "$ALERT" ]; then
  logger -t "$TAG" "ALERT (no email configured): $FAILED failed logins, $DENIED access denied, $ROLE_CHANGES role changes"
fi

# Always log daily summary
logger -t "$TAG" "Daily check: $FAILED failed logins, $DENIED access denied, $SUPERADMINS superadmins, $ROLE_CHANGES role changes"
