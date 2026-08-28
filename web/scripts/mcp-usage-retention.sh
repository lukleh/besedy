#!/usr/bin/env bash
# Roll raw MCP telemetry into daily aggregates, then prune expired rows.

set -euo pipefail

COMPOSE_DIR="${BESEDY_COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="$(cd "$COMPOSE_DIR/.." && pwd)"
MCP_RAW_RETENTION_DAYS="${MCP_RAW_RETENTION_DAYS:-180}"
MCP_ROLLUP_RETENTION_DAYS="${MCP_ROLLUP_RETENTION_DAYS:-400}"
MIN_MCP_ROLLUP_RETENTION_DAYS=366
TAG="${REPORT_LOG_TAG:-besedy-mcp-retention}"

case "$MCP_RAW_RETENTION_DAYS" in
    ''|*[!0-9]*|0)
        echo "MCP_RAW_RETENTION_DAYS must be a positive integer, got: $MCP_RAW_RETENTION_DAYS" >&2
        exit 1
        ;;
esac

case "$MCP_ROLLUP_RETENTION_DAYS" in
    ''|*[!0-9]*|0)
        echo "MCP_ROLLUP_RETENTION_DAYS must be a positive integer, got: $MCP_ROLLUP_RETENTION_DAYS" >&2
        exit 1
        ;;
esac

if (( MCP_ROLLUP_RETENTION_DAYS < MIN_MCP_ROLLUP_RETENTION_DAYS )); then
    echo "MCP_ROLLUP_RETENTION_DAYS must be at least $MIN_MCP_ROLLUP_RETENTION_DAYS to preserve 12-month reports" >&2
    exit 1
fi

compose_cmd() {
    "$PROJECT_DIR/scripts/run_web_compose.sh" production "$@"
}

RESULT="$(compose_cmd exec -T db psql \
    -U besedy_app \
    -d besedy \
    -v ON_ERROR_STOP=1 \
    -v retention_days="$MCP_RAW_RETENTION_DAYS" \
    -v rollup_retention_days="$MCP_ROLLUP_RETENTION_DAYS" \
    -qAt <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';

DO $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('besedy:mcp-usage-retention', 0)
    );
END
$$;

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
    COALESCE((SELECT COUNT(*) FROM rolled_up), 0) AS daily_groups_updated,
    COALESCE((SELECT COUNT(*) FROM deleted), 0) AS raw_rows_deleted
\gset retention_

WITH expired_rollups AS (
    DELETE FROM mcp_tool_usage_daily
    WHERE usage_date < CURRENT_DATE - :'rollup_retention_days'::integer
    RETURNING 1
)
SELECT COUNT(*) AS daily_groups_deleted
FROM expired_rollups
\gset retention_

SELECT
    :'retention_daily_groups_updated' || ' daily groups updated, ' ||
    :'retention_raw_rows_deleted' || ' raw rows rolled up and deleted, ' ||
    :'retention_daily_groups_deleted' || ' expired daily groups deleted';

COMMIT;
SQL
)"

echo "MCP usage retention: $RESULT"
logger -t "$TAG" "MCP usage retention: $RESULT"
