ALTER TABLE "mcp_tool_invocation"
ADD COLUMN "actor_user_id" TEXT;

UPDATE "mcp_tool_invocation"
SET "actor_user_id" = COALESCE("user_id", 'deleted:' || "id");

ALTER TABLE "mcp_tool_invocation"
ALTER COLUMN "actor_user_id" SET NOT NULL;

CREATE INDEX "mcp_tool_invocation_actor_user_id_created_at_idx"
ON "mcp_tool_invocation"("actor_user_id", "created_at");

CREATE TABLE "mcp_tool_usage_daily" (
    "id" TEXT NOT NULL,
    "usage_date" DATE NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT,
    "tool_name" VARCHAR(64) NOT NULL,
    "catalog_id" VARCHAR(191) NOT NULL DEFAULT '',
    "outcome" "McpToolOutcome" NOT NULL,
    "calls" INTEGER NOT NULL,
    "total_duration_ms" BIGINT NOT NULL,
    "result_count" BIGINT NOT NULL,
    "returned_text_chars" BIGINT NOT NULL,
    "first_used_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_tool_usage_daily_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mcp_tool_usage_daily_calls_check" CHECK ("calls" > 0),
    CONSTRAINT "mcp_tool_usage_daily_duration_check" CHECK ("total_duration_ms" >= 0),
    CONSTRAINT "mcp_tool_usage_daily_result_count_check" CHECK ("result_count" >= 0),
    CONSTRAINT "mcp_tool_usage_daily_text_chars_check" CHECK ("returned_text_chars" >= 0)
);

CREATE UNIQUE INDEX "mcp_tool_usage_daily_dimensions_key"
ON "mcp_tool_usage_daily"("usage_date", "actor_user_id", "client_id", "tool_name", "catalog_id", "outcome");
CREATE INDEX "mcp_tool_usage_daily_usage_date_idx" ON "mcp_tool_usage_daily"("usage_date");
CREATE INDEX "mcp_tool_usage_daily_actor_user_id_usage_date_idx" ON "mcp_tool_usage_daily"("actor_user_id", "usage_date");
CREATE INDEX "mcp_tool_usage_daily_client_id_usage_date_idx" ON "mcp_tool_usage_daily"("client_id", "usage_date");
CREATE INDEX "mcp_tool_usage_daily_tool_name_usage_date_idx" ON "mcp_tool_usage_daily"("tool_name", "usage_date");
CREATE INDEX "mcp_tool_usage_daily_catalog_id_usage_date_idx" ON "mcp_tool_usage_daily"("catalog_id", "usage_date");

CREATE VIEW "mcp_tool_usage" AS
SELECT
    "created_at" AS "occurred_at",
    "created_at" AS "last_used_at",
    "actor_user_id",
    "client_id",
    "client_name",
    "tool_name",
    "catalog_id",
    "outcome",
    1::bigint AS "calls",
    "duration_ms"::bigint AS "total_duration_ms",
    COALESCE("result_count", 0)::bigint AS "result_count",
    COALESCE("returned_text_chars", 0)::bigint AS "returned_text_chars"
FROM "mcp_tool_invocation"

UNION ALL

SELECT
    "usage_date"::timestamp AS "occurred_at",
    "last_used_at",
    "actor_user_id",
    "client_id",
    "client_name",
    "tool_name",
    NULLIF("catalog_id", '') AS "catalog_id",
    "outcome",
    "calls"::bigint,
    "total_duration_ms",
    "result_count",
    "returned_text_chars"
FROM "mcp_tool_usage_daily";
