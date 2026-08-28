#!/usr/bin/env bash
# Roll raw MCP telemetry into daily aggregates, then prune expired rows.

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
MCP_RAW_RETENTION_DAYS="${MCP_RAW_RETENTION_DAYS:-180}"
TAG="${REPORT_LOG_TAG:-besedy-mcp-retention}"

case "$MCP_RAW_RETENTION_DAYS" in
    ''|*[!0-9]*|0)
        echo "MCP_RAW_RETENTION_DAYS must be a positive integer, got: $MCP_RAW_RETENTION_DAYS" >&2
        exit 1
        ;;
esac

compose_cmd() {
    "$PROJECT_DIR/scripts/run_web_compose.sh" production "$@"
}

RESULT="$(compose_cmd exec -T db psql \
    -U besedy_app \
    -d besedy \
    -v ON_ERROR_STOP=1 \
    -v retention_days="$MCP_RAW_RETENTION_DAYS" \
    -qAt <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';

WITH rolled_up AS (
    INSERT INTO mcp_tool_usage_daily (
        id,
        usage_date,
        actor_user_id,
        client_id,
        client_name,
        tool_name,
        catalog_id,
        outcome,
        calls,
        total_duration_ms,
        result_count,
        returned_text_chars,
        first_used_at,
        last_used_at
    )
    SELECT
        md5(jsonb_build_array(
            created_at::date,
            actor_user_id,
            client_id,
            tool_name,
            COALESCE(catalog_id, ''),
            outcome::text
        )::text),
        created_at::date,
        actor_user_id,
        client_id,
        (ARRAY_AGG(client_name ORDER BY created_at DESC)
            FILTER (WHERE client_name IS NOT NULL))[1],
        tool_name,
        COALESCE(catalog_id, ''),
        outcome,
        COUNT(*)::integer,
        SUM(duration_ms)::bigint,
        SUM(COALESCE(result_count, 0))::bigint,
        SUM(COALESCE(returned_text_chars, 0))::bigint,
        MIN(created_at),
        MAX(created_at)
    FROM mcp_tool_invocation
    WHERE created_at < CURRENT_DATE - make_interval(days => :'retention_days'::integer)
    GROUP BY
        created_at::date,
        actor_user_id,
        client_id,
        tool_name,
        COALESCE(catalog_id, ''),
        outcome
    ON CONFLICT (usage_date, actor_user_id, client_id, tool_name, catalog_id, outcome)
    DO UPDATE SET
        client_name = COALESCE(EXCLUDED.client_name, mcp_tool_usage_daily.client_name),
        calls = mcp_tool_usage_daily.calls + EXCLUDED.calls,
        total_duration_ms = mcp_tool_usage_daily.total_duration_ms + EXCLUDED.total_duration_ms,
        result_count = mcp_tool_usage_daily.result_count + EXCLUDED.result_count,
        returned_text_chars = mcp_tool_usage_daily.returned_text_chars + EXCLUDED.returned_text_chars,
        first_used_at = LEAST(mcp_tool_usage_daily.first_used_at, EXCLUDED.first_used_at),
        last_used_at = GREATEST(mcp_tool_usage_daily.last_used_at, EXCLUDED.last_used_at)
    RETURNING 1
), deleted AS (
    DELETE FROM mcp_tool_invocation
    WHERE created_at < CURRENT_DATE - make_interval(days => :'retention_days'::integer)
    RETURNING 1
)
SELECT
    COALESCE((SELECT COUNT(*) FROM rolled_up), 0) || ' daily groups updated, ' ||
    COALESCE((SELECT COUNT(*) FROM deleted), 0) || ' raw rows rolled up and deleted';

COMMIT;
SQL
)"

echo "MCP usage retention: $RESULT"
logger -t "$TAG" "MCP usage retention: $RESULT"
