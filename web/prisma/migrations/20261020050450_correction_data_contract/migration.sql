-- ADR 0012: the correction data contract.
--
-- Human corrections cannot be redone, so everything later training needs is
-- stored from the first correction on: how spans were cut from the decoded
-- chunks, the staged audio they refer to, where each revision's text came from
-- and under which guide, how much of a span a person heard before deciding,
-- flags on the audio, and contributor consent.
--
-- Every change is additive. Existing rows keep their values; the new columns
-- are null on the one workspace started before this contract, and the
-- checks below require new ones to be complete. Foreign keys inside the
-- correction tables, and from catalogs to them, change from CASCADE to
-- RESTRICT, so deleting a catalog or a workspace can no longer delete
-- correction work.

-- CreateEnum
CREATE TYPE "TranscriptRevisionOrigin" AS ENUM ('MACHINE', 'MANUAL', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "TranscriptSpanFlagKind" AS ENUM ('UNCLEAR', 'OVERLAP', 'OTHER_LANGUAGE', 'MUSIC_NOISE', 'CUT_WORD', 'EXCLUDE_FROM_TRAINING');

-- CreateEnum
CREATE TYPE "TranscriptSpanFlagAction" AS ENUM ('SET', 'CLEAR');

-- DropForeignKey
ALTER TABLE "transcript_guide_revision" DROP CONSTRAINT "transcript_guide_revision_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_publication" DROP CONSTRAINT "transcript_publication_guide_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_publication" DROP CONSTRAINT "transcript_publication_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_publication_span" DROP CONSTRAINT "transcript_publication_span_publication_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_publication_span" DROP CONSTRAINT "transcript_publication_span_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_publication_span" DROP CONSTRAINT "transcript_publication_span_span_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span" DROP CONSTRAINT "transcript_span_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_comment" DROP CONSTRAINT "transcript_span_comment_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_comment" DROP CONSTRAINT "transcript_span_comment_span_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_comment" DROP CONSTRAINT "transcript_span_comment_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_decision" DROP CONSTRAINT "transcript_span_decision_revision_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_decision" DROP CONSTRAINT "transcript_span_decision_span_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_decision" DROP CONSTRAINT "transcript_span_decision_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_revision" DROP CONSTRAINT "transcript_span_revision_span_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_span_revision" DROP CONSTRAINT "transcript_span_revision_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "transcript_workspace" DROP CONSTRAINT "transcript_workspace_workflow_group_id_fkey";

-- AlterTable
ALTER TABLE "transcript_span" ADD COLUMN     "chunk_ordinal" INTEGER,
ADD COLUMN     "end_sample" INTEGER,
ADD COLUMN     "first_region_index" INTEGER,
ADD COLUMN     "last_region_index" INTEGER,
ADD COLUMN     "machine_words" JSONB,
ADD COLUMN     "speech_regions" JSONB,
ADD COLUMN     "start_sample" INTEGER;

-- AlterTable
ALTER TABLE "transcript_span_decision" ADD COLUMN     "heard_fraction" DOUBLE PRECISION,
ADD COLUMN     "max_playback_rate" DOUBLE PRECISION,
ADD COLUMN     "min_playback_rate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "transcript_span_revision" ADD COLUMN     "guide_revision_id" UUID,
ADD COLUMN     "origin" "TranscriptRevisionOrigin",
ADD COLUMN     "suggestion_backend" VARCHAR(255);

-- AlterTable
ALTER TABLE "transcript_workspace" ADD COLUMN     "segmentation_params" JSONB,
ADD COLUMN     "segmentation_version" VARCHAR(32),
ADD COLUMN     "source_chunk_count" INTEGER,
ADD COLUMN     "staged_audio_path" TEXT,
ADD COLUMN     "staged_audio_sha256" VARCHAR(64),
ADD COLUMN     "staged_audio_size" BIGINT;

-- CreateTable
CREATE TABLE "transcript_span_flag_event" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "kind" "TranscriptSpanFlagKind" NOT NULL,
    "action" "TranscriptSpanFlagAction" NOT NULL,
    "language_code" VARCHAR(8),
    "comment" TEXT,
    "actor_key" TEXT NOT NULL,
    "user_id" TEXT,
    "idempotency_key" VARCHAR(64),
    "sequence" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_span_flag_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_contributor_consent" (
    "id" UUID NOT NULL,
    "actor_key" TEXT NOT NULL,
    "user_id" TEXT,
    "terms_version" VARCHAR(32) NOT NULL,
    "terms_text" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_contributor_consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcript_span_flag_event_span_id_kind_sequence_idx" ON "transcript_span_flag_event"("span_id", "kind", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_span_flag_event_workspace_id_actor_key_idempoten_key" ON "transcript_span_flag_event"("workspace_id", "actor_key", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_contributor_consent_actor_key_terms_version_key" ON "transcript_contributor_consent"("actor_key", "terms_version");

-- CreateIndex
CREATE INDEX "transcript_span_workspace_id_chunk_ordinal_idx" ON "transcript_span"("workspace_id", "chunk_ordinal");

-- AddForeignKey
ALTER TABLE "transcript_workspace" ADD CONSTRAINT "transcript_workspace_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span" ADD CONSTRAINT "transcript_span_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_revision" ADD CONSTRAINT "transcript_span_revision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_revision" ADD CONSTRAINT "transcript_span_revision_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_revision" ADD CONSTRAINT "transcript_span_revision_guide_revision_id_fkey" FOREIGN KEY ("guide_revision_id") REFERENCES "transcript_guide_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_decision" ADD CONSTRAINT "transcript_span_decision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_decision" ADD CONSTRAINT "transcript_span_decision_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_decision" ADD CONSTRAINT "transcript_span_decision_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_comment" ADD CONSTRAINT "transcript_span_comment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_comment" ADD CONSTRAINT "transcript_span_comment_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_comment" ADD CONSTRAINT "transcript_span_comment_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_publication" ADD CONSTRAINT "transcript_publication_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_publication" ADD CONSTRAINT "transcript_publication_guide_revision_id_fkey" FOREIGN KEY ("guide_revision_id") REFERENCES "transcript_guide_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_publication_span" ADD CONSTRAINT "transcript_publication_span_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "transcript_publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_publication_span" ADD CONSTRAINT "transcript_publication_span_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_publication_span" ADD CONSTRAINT "transcript_publication_span_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_guide_revision" ADD CONSTRAINT "transcript_guide_revision_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_flag_event" ADD CONSTRAINT "transcript_span_flag_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_flag_event" ADD CONSTRAINT "transcript_span_flag_event_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_span_flag_event" ADD CONSTRAINT "transcript_span_flag_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_contributor_consent" ADD CONSTRAINT "transcript_contributor_consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The contract columns of a workspace are set together, or not at all on a
-- workspace started before this contract. Each column is required explicitly
-- in the second branch: a NULL there would otherwise make the whole check
-- pass, because (FALSE OR NULL) is not FALSE.
ALTER TABLE "transcript_workspace" ADD CONSTRAINT "transcript_workspace_contract_check" CHECK (
  (
    "segmentation_version" IS NULL AND "segmentation_params" IS NULL AND "source_chunk_count" IS NULL
    AND "staged_audio_path" IS NULL AND "staged_audio_size" IS NULL AND "staged_audio_sha256" IS NULL
  ) OR (
    "segmentation_version" IS NOT NULL AND "segmentation_params" IS NOT NULL
    AND "source_chunk_count" IS NOT NULL AND "source_chunk_count" > 0
    AND "staged_audio_path" IS NOT NULL
    AND "staged_audio_size" IS NOT NULL AND "staged_audio_size" > 0
    AND "staged_audio_sha256" IS NOT NULL AND length("staged_audio_sha256") = 64
  )
);

-- A span's chunk and region data are set together and describe a real range.
-- As above, every column is required explicitly in the second branch.
ALTER TABLE "transcript_span" ADD CONSTRAINT "transcript_span_contract_check" CHECK (
  (
    "chunk_ordinal" IS NULL AND "first_region_index" IS NULL AND "last_region_index" IS NULL
    AND "start_sample" IS NULL AND "end_sample" IS NULL AND "speech_regions" IS NULL AND "machine_words" IS NULL
  ) OR (
    "chunk_ordinal" IS NOT NULL AND "chunk_ordinal" >= 0
    AND "first_region_index" IS NOT NULL AND "first_region_index" >= 0
    AND "last_region_index" IS NOT NULL AND "last_region_index" >= "first_region_index"
    AND "start_sample" IS NOT NULL AND "start_sample" >= 0
    AND "end_sample" IS NOT NULL AND "end_sample" > "start_sample"
    AND "speech_regions" IS NOT NULL AND jsonb_typeof("speech_regions") = 'array'
    AND "machine_words" IS NOT NULL AND jsonb_typeof("machine_words") = 'array'
  )
);

-- A suggestion names its backend, and only a suggestion does.
ALTER TABLE "transcript_span_revision" ADD CONSTRAINT "transcript_span_revision_suggestion_check" CHECK (
  ("suggestion_backend" IS NULL OR "origin" = 'SUGGESTION')
  AND ("origin" IS DISTINCT FROM 'SUGGESTION' OR "suggestion_backend" IS NOT NULL)
);

-- Playback is recorded as a whole or not at all: the heard share of the span
-- together with both playback rates, the share within [0, 1] and the rates
-- positive and ordered.
ALTER TABLE "transcript_span_decision" ADD CONSTRAINT "transcript_span_decision_playback_check" CHECK (
  num_nulls("heard_fraction", "min_playback_rate", "max_playback_rate") IN (0, 3)
  AND ("heard_fraction" IS NULL OR ("heard_fraction" >= 0 AND "heard_fraction" <= 1))
  AND ("min_playback_rate" IS NULL OR "min_playback_rate" > 0)
  AND ("max_playback_rate" IS NULL OR "max_playback_rate" > 0)
  AND ("min_playback_rate" IS NULL OR "max_playback_rate" IS NULL OR "min_playback_rate" <= "max_playback_rate")
);

-- Only an other-language flag carries a language code.
ALTER TABLE "transcript_span_flag_event" ADD CONSTRAINT "transcript_span_flag_event_language_check" CHECK (
  "language_code" IS NULL OR "kind" = 'OTHER_LANGUAGE'
);
