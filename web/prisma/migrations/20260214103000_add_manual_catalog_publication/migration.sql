-- Add manual publication state for catalog entries.
-- Publication controls LISTENER visibility and notifications.

ALTER TABLE "catalog_entry"
  ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing actionable rows as published, except one explicitly withheld hash.
UPDATE "catalog_entry"
SET "is_published" = true
WHERE "is_actionable" = true
  AND "audio_hash" <> 'a7a699538cec617da00af2523509a947ced382efdbaeabe9f2defdd7614e2a97';

CREATE INDEX "catalog_entry_workflow_group_id_is_published_idx"
  ON "catalog_entry"("workflow_group_id", "is_published");
