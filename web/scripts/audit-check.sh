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
ENV_FILE="$("$PROJECT_DIR/scripts/resolve_web_env_file.sh" production)"
THRESHOLD_FAILED_LOGIN="${THRESHOLD_FAILED_LOGIN:-5}"

# Compose command for production (base + security overlay)
compose_cmd() {
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.secure.yml" --env-file "$ENV_FILE" "$@"
}
THRESHOLD_ACCESS_DENIED="${THRESHOLD_ACCESS_DENIED:-10}"
ALERT_EMAIL="${ALERT_EMAIL:-}"

# Check failed logins in last 24 hours
FAILED=$(compose_cmd exec -T db \
  psql -U besedy_app -d besedy -tA -c "
    SELECT COUNT(*) FROM audit_log
    WHERE action = 'LOGIN_FAILED'
    AND created_at > NOW() - INTERVAL '24 hours'" 2>/dev/null || echo "0")

# Check access denied events in last 24 hours
DENIED=$(compose_cmd exec -T db \
  psql -U besedy_app -d besedy -tA -c "
    SELECT COUNT(*) FROM audit_log
    WHERE action = 'ACCESS_DENIED'
    AND created_at > NOW() - INTERVAL '24 hours'" 2>/dev/null || echo "0")

# Check current superadmin count (should rarely change)
SUPERADMINS=$(compose_cmd exec -T db \
  psql -U besedy_app -d besedy -tA -c "
    SELECT COUNT(*) FROM users WHERE is_superadmin = true" 2>/dev/null || echo "0")

# Check for recent admin role changes
ROLE_CHANGES=$(compose_cmd exec -T db \
  psql -U besedy_app -d besedy -tA -c "
    SELECT COUNT(*) FROM audit_log
    WHERE action IN ('ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
    AND created_at > NOW() - INTERVAL '24 hours'" 2>/dev/null || echo "0")

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

  logger -t besedy-audit "Alert sent to $ALERT_EMAIL: $FAILED failed logins, $DENIED access denied, $ROLE_CHANGES role changes"
elif [ -n "$ALERT" ]; then
  logger -t besedy-audit "ALERT (no email configured): $FAILED failed logins, $DENIED access denied, $ROLE_CHANGES role changes"
fi

# Always log daily summary
logger -t besedy-audit "Daily check: $FAILED failed logins, $DENIED access denied, $SUPERADMINS superadmins, $ROLE_CHANGES role changes"
