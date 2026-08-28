CREATE TYPE "McpToolOutcome" AS ENUM ('SUCCESS', 'ERROR', 'DENIED');

CREATE TABLE "mcp_tool_invocation" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "client_id" TEXT NOT NULL,
    "client_name" VARCHAR(255),
    "tool_name" VARCHAR(64) NOT NULL,
    "catalog_id" VARCHAR(191),
    "target_type" VARCHAR(50),
    "target_id" VARCHAR(191),
    "outcome" "McpToolOutcome" NOT NULL,
    "error_code" VARCHAR(100),
    "duration_ms" INTEGER NOT NULL,
    "result_count" INTEGER,
    "returned_text_chars" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tool_invocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mcp_tool_invocation_duration_ms_check" CHECK ("duration_ms" >= 0),
    CONSTRAINT "mcp_tool_invocation_result_count_check" CHECK ("result_count" IS NULL OR "result_count" >= 0),
    CONSTRAINT "mcp_tool_invocation_returned_text_chars_check" CHECK ("returned_text_chars" IS NULL OR "returned_text_chars" >= 0)
);

CREATE INDEX "mcp_tool_invocation_created_at_idx" ON "mcp_tool_invocation"("created_at");
CREATE INDEX "mcp_tool_invocation_user_id_created_at_idx" ON "mcp_tool_invocation"("user_id", "created_at");
CREATE INDEX "mcp_tool_invocation_client_id_created_at_idx" ON "mcp_tool_invocation"("client_id", "created_at");
CREATE INDEX "mcp_tool_invocation_tool_name_created_at_idx" ON "mcp_tool_invocation"("tool_name", "created_at");
CREATE INDEX "mcp_tool_invocation_catalog_id_created_at_idx" ON "mcp_tool_invocation"("catalog_id", "created_at");
CREATE INDEX "mcp_tool_invocation_outcome_created_at_idx" ON "mcp_tool_invocation"("outcome", "created_at");

ALTER TABLE "mcp_tool_invocation"
ADD CONSTRAINT "mcp_tool_invocation_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
