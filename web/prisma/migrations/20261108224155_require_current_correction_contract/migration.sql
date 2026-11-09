BEGIN;

-- ADR 0012 current-contract cutover. Serialize the inventory and deletion:
-- no contributor can add work between the guard and the removal.
LOCK TABLE "transcript_workspace", "transcript_span", "transcript_span_revision",
  "transcript_span_decision", "transcript_span_comment", "transcript_span_flag_event",
  "transcript_publication", "transcript_publication_span" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "transcript_workspace" w
    WHERE w."segmentation_version" IS NULL AND (
      w."status" <> 'ARCHIVED' OR w."reader_publication_id" IS NOT NULL
      OR w."search_publication_id" IS NOT NULL OR w."search_withdrawal_id" IS NOT NULL
      OR w."search_withdrawal_job_id" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "transcript_publication" p WHERE p."workspace_id" = w."id")
      OR EXISTS (SELECT 1 FROM "transcript_span_decision" d WHERE d."workspace_id" = w."id")
      OR EXISTS (SELECT 1 FROM "transcript_span_comment" c WHERE c."workspace_id" = w."id")
      OR EXISTS (SELECT 1 FROM "transcript_span_flag_event" f WHERE f."workspace_id" = w."id")
      OR EXISTS (
        SELECT 1 FROM "transcript_span_revision" r
        JOIN "transcript_span" s ON s."id" = r."span_id"
        WHERE r."workspace_id" = w."id" AND (
          r."actor_key" IS NOT NULL OR r."author_id" IS NOT NULL
          OR r."previous_revision_id" IS NOT NULL OR r."origin" IS NOT NULL
          OR r."guide_revision_id" IS NOT NULL OR r."suggestion_backend" IS NOT NULL
          OR r."text" <> s."original_text" OR r."text_hash" <> s."original_text_hash"
        )
      )
      OR EXISTS (
        SELECT 1 FROM "transcript_span" s WHERE s."workspace_id" = w."id" AND (
          (SELECT count(*) FROM "transcript_span_revision" r WHERE r."span_id" = s."id") <> 1
          OR NOT EXISTS (SELECT 1 FROM "transcript_span_revision" r
            WHERE r."id" = s."current_revision_id" AND r."span_id" = s."id")
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Refusing to retire pre-contract correction workspaces with live state or human/provenance records';
  END IF;
END $$;

-- Break only the import cycle of the guarded machine-only archived snapshots.
UPDATE "transcript_span" s SET "current_revision_id" = NULL
FROM "transcript_workspace" w WHERE s."workspace_id" = w."id" AND w."segmentation_version" IS NULL;
DELETE FROM "transcript_span_revision" r USING "transcript_workspace" w
WHERE r."workspace_id" = w."id" AND w."segmentation_version" IS NULL;
DELETE FROM "transcript_span" s USING "transcript_workspace" w
WHERE s."workspace_id" = w."id" AND w."segmentation_version" IS NULL;
DELETE FROM "transcript_workspace" WHERE "segmentation_version" IS NULL;

-- AlterTable
ALTER TABLE "transcript_span" ALTER COLUMN "chunk_ordinal" SET NOT NULL,
ALTER COLUMN "end_sample" SET NOT NULL,
ALTER COLUMN "first_region_index" SET NOT NULL,
ALTER COLUMN "last_region_index" SET NOT NULL,
ALTER COLUMN "machine_words" SET NOT NULL,
ALTER COLUMN "speech_regions" SET NOT NULL,
ALTER COLUMN "start_sample" SET NOT NULL;

-- AlterTable
ALTER TABLE "transcript_span_decision" ALTER COLUMN "command_name" SET NOT NULL,
ALTER COLUMN "command_digest" SET NOT NULL;

-- AlterTable
ALTER TABLE "transcript_span_revision" ALTER COLUMN "guide_revision_id" SET NOT NULL,
ALTER COLUMN "origin" SET NOT NULL;

-- AlterTable
ALTER TABLE "transcript_workspace" ALTER COLUMN "segmentation_params" SET NOT NULL,
ALTER COLUMN "segmentation_version" SET NOT NULL,
ALTER COLUMN "source_chunk_count" SET NOT NULL,
ALTER COLUMN "staged_audio_path" SET NOT NULL,
ALTER COLUMN "staged_audio_sha256" SET NOT NULL,
ALTER COLUMN "staged_audio_size" SET NOT NULL;

-- The data contract has one current version; unknown versions need migration.
ALTER TABLE "transcript_workspace" DROP CONSTRAINT "transcript_workspace_contract_check";
ALTER TABLE "transcript_workspace" ADD CONSTRAINT "transcript_workspace_contract_check" CHECK (
  "segmentation_version" = 'chunks-v1'
  AND "segmentation_params" = '{"sampleRate":16000,"maxChunkSpeechSamples":480000,"splitGapSamples":16000,"maxSpanSamples":480000,"mergeBelowSamples":32000}'::jsonb
  AND "source_chunk_count" > 0 AND "staged_audio_size" > 0
  AND length("staged_audio_path") > 0 AND "staged_audio_sha256" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "transcript_span" DROP CONSTRAINT "transcript_span_contract_check";
ALTER TABLE "transcript_span" ADD CONSTRAINT "transcript_span_contract_check" CHECK (
  "chunk_ordinal" >= 0 AND "first_region_index" >= 0
  AND "last_region_index" >= "first_region_index" AND "start_sample" >= 0
  AND "end_sample" > "start_sample"
  AND jsonb_typeof("speech_regions") = 'array' AND jsonb_array_length("speech_regions") > 0
  AND jsonb_typeof("machine_words") = 'array'
);
ALTER TABLE "transcript_span_decision" DROP CONSTRAINT "transcript_span_decision_playback_check";
ALTER TABLE "transcript_span_decision" ADD CONSTRAINT "transcript_span_decision_playback_check" CHECK (
  ("kind" = 'WITHDRAW' AND num_nulls("heard_fraction", "min_playback_rate", "max_playback_rate") = 3)
  OR ("kind" <> 'WITHDRAW' AND num_nulls("heard_fraction", "min_playback_rate", "max_playback_rate") = 0
    AND "heard_fraction" >= 0 AND "heard_fraction" <= 1
    AND "min_playback_rate" > 0 AND "max_playback_rate" >= "min_playback_rate")
);

COMMIT;
