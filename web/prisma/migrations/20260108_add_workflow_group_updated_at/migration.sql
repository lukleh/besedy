-- Add updated_at column to workflow_group for tracking catalog changes
ALTER TABLE "workflow_group" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows: use MAX(audio_metadata.updated_at) if available, otherwise created_at
UPDATE "workflow_group" wg
SET "updated_at" = COALESCE(
  (SELECT MAX("updated_at") FROM "audio_metadata" am WHERE am."workflow_group_id" = wg."id"),
  wg."created_at"
);
