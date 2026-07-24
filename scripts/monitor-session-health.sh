#!/bin/bash
# Session Health Monitor
# Run after deployment to check for auth/session issues
#
# Usage: ./scripts/monitor-session-health.sh [hours]
#        hours: lookback period (default: 24)

set -e

HOURS=${1:-24}
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${BOLD}Session Health Monitor${NC}"
echo "Checking last ${HOURS} hours..."
echo ""

# Check if prod containers are running
if ! docker ps | grep -q besedy-production-web; then
    echo -e "${RED}Error: besedy-production-web container not running${NC}"
    exit 1
fi

if ! docker ps | grep -q besedy-production-db; then
    echo -e "${RED}Error: besedy-production-db container not running${NC}"
    exit 1
fi

echo -e "${BOLD}1. Login Frequency (users with >3 logins = potential session issues)${NC}"
echo "─────────────────────────────────────────────────────────────────"
docker exec besedy-production-db psql -U besedy -d besedy -t -c "
SELECT
  COALESCE(u.email, 'unknown') as email,
  COUNT(*) as logins,
  TO_CHAR(MIN(al.created_at), 'HH24:MI') as first,
  TO_CHAR(MAX(al.created_at), 'HH24:MI') as last
FROM audit_log al
LEFT JOIN users u ON al.user_id = u.id
WHERE al.action = 'LOGIN'
  AND al.created_at > NOW() - INTERVAL '${HOURS} hours'
GROUP BY u.email
HAVING COUNT(*) > 3
ORDER BY COUNT(*) DESC
LIMIT 10;
" 2>/dev/null || echo "  (no excessive logins found)"
echo ""

echo -e "${BOLD}2. Recent Login Activity Summary${NC}"
echo "─────────────────────────────────────────────────────────────────"
docker exec besedy-production-db psql -U besedy -d besedy -t -c "
SELECT
  COUNT(DISTINCT user_id) as unique_users,
  COUNT(*) as total_logins,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT user_id), 0), 1) as avg_per_user
FROM audit_log
WHERE action = 'LOGIN'
  AND created_at > NOW() - INTERVAL '${HOURS} hours';
" 2>/dev/null
echo ""

echo -e "${BOLD}3. Client Error Reports (auth-related)${NC}"
echo "─────────────────────────────────────────────────────────────────"
AUTH_ERRORS=$(docker exec besedy-production-db psql -U besedy -d besedy -t -c "
SELECT COUNT(*)
FROM client_error_report
WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
  AND (
    LOWER(message) LIKE '%session%' OR
    LOWER(message) LIKE '%auth%' OR
    LOWER(message) LIKE '%unauthorized%' OR
    LOWER(message) LIKE '%401%' OR
    LOWER(message) LIKE '%token%'
  );
" 2>/dev/null | tr -d ' ')

if [ "$AUTH_ERRORS" -gt 0 ] 2>/dev/null; then
    echo -e "${YELLOW}Found ${AUTH_ERRORS} auth-related error(s):${NC}"
    docker exec besedy-production-db psql -U besedy -d besedy -c "
    SELECT
      TO_CHAR(created_at, 'MM-DD HH24:MI') as time,
      LEFT(message, 60) as message,
      source
    FROM client_error_report
    WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
      AND (
        LOWER(message) LIKE '%session%' OR
        LOWER(message) LIKE '%auth%' OR
        LOWER(message) LIKE '%unauthorized%' OR
        LOWER(message) LIKE '%401%' OR
        LOWER(message) LIKE '%token%'
      )
    ORDER BY created_at DESC
    LIMIT 5;
    " 2>/dev/null
else
    echo -e "${GREEN}No auth-related client errors${NC}"
fi
echo ""

echo -e "${BOLD}4. Total Client Errors (last ${HOURS}h)${NC}"
echo "─────────────────────────────────────────────────────────────────"
docker exec besedy-production-db psql -U besedy -d besedy -c "
SELECT
  source,
  COUNT(*) as count,
  COUNT(DISTINCT digest) as unique_errors
FROM client_error_report
WHERE created_at > NOW() - INTERVAL '${HOURS} hours'
GROUP BY source
ORDER BY count DESC;
" 2>/dev/null || echo "  (no errors found)"
echo ""

echo -e "${BOLD}5. Server Log Errors (auth-related, last 100 lines)${NC}"
echo "─────────────────────────────────────────────────────────────────"
AUTH_LOG_ERRORS=$(docker logs besedy-production-web --tail=100 2>&1 | grep -ciE "(session.*error|auth.*error|unauthorized|401)" || true)
if [ "$AUTH_LOG_ERRORS" -gt 0 ]; then
    echo -e "${YELLOW}Found ${AUTH_LOG_ERRORS} potential auth error(s) in logs:${NC}"
    docker logs besedy-production-web --tail=100 2>&1 | grep -iE "(session.*error|auth.*error|unauthorized|401)" | tail -5
else
    echo -e "${GREEN}No auth errors in recent server logs${NC}"
fi
echo ""

echo -e "${BOLD}6. Active Sessions${NC}"
echo "─────────────────────────────────────────────────────────────────"
docker exec besedy-production-db psql -U besedy -d besedy -c "
SELECT
  COUNT(*) as total_sessions,
  COUNT(*) FILTER (WHERE expires_at > NOW()) as active,
  COUNT(*) FILTER (WHERE expires_at <= NOW()) as expired,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '1 hour') as recently_active
FROM sessions;
" 2>/dev/null
echo ""

echo -e "${BOLD}7. Health Check${NC}"
echo "─────────────────────────────────────────────────────────────────"
# Check session endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/auth/get-session 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}Session endpoint: OK (HTTP ${HTTP_CODE})${NC}"
else
    echo -e "${RED}Session endpoint: FAILED (HTTP ${HTTP_CODE})${NC}"
fi

# Check version endpoint
VERSION=$(curl -s http://localhost:3000/api/version 2>/dev/null | grep -o '"commit":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
echo "Deployed version: ${VERSION:0:7}"
echo ""

echo -e "${BOLD}Summary${NC}"
echo "─────────────────────────────────────────────────────────────────"
if [ "$AUTH_ERRORS" -gt 0 ] 2>/dev/null || [ "$AUTH_LOG_ERRORS" -gt 0 ]; then
    echo -e "${YELLOW}Potential issues detected - review above${NC}"
else
    echo -e "${GREEN}No obvious session/auth issues detected${NC}"
fi
