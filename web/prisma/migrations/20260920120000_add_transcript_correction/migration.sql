ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_CORRECTION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_CORRECTION_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_GUIDE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_UNPUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'TRANSCRIPT_ORIGINAL_DOWNLOADED';

CREATE TYPE "TranscriptWorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "TranscriptPublicationStatus" AS ENUM ('PENDING', 'ACTIVATING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');
CREATE TYPE "TranscriptDecisionKind" AS ENUM ('APPROVE', 'DISAPPROVE', 'WITHDRAW');

CREATE TABLE "transcript_guide_revision" (
    "id" UUID NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_guide_revision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transcript_guide_revision_workflow_group_id_created_at_idx"
ON "transcript_guide_revision"("workflow_group_id", "created_at");

CREATE TABLE "transcript_workspace" (
    "id" UUID NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "source_backend" VARCHAR(255) NOT NULL,
    "source_fingerprint" VARCHAR(64) NOT NULL,
    "span_duration_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "span_count" INTEGER NOT NULL DEFAULT 0,
    "status" "TranscriptWorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "reader_publication_id" UUID,
    "search_publication_id" UUID,
    "started_by" TEXT,
    "archived_by" TEXT,
    "archive_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "transcript_workspace_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_workspace_audio_hash_check" CHECK ("audio_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "transcript_workspace_source_fingerprint_check" CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "transcript_workspace_archived_fields_check" CHECK (
        ("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "transcript_workspace_reader_publication_id_key"
ON "transcript_workspace"("reader_publication_id");

CREATE UNIQUE INDEX "transcript_workspace_search_publication_id_key"
ON "transcript_workspace"("search_publication_id");

CREATE INDEX "transcript_workspace_workflow_group_id_audio_hash_idx"
ON "transcript_workspace"("workflow_group_id", "audio_hash");

CREATE INDEX "transcript_workspace_workflow_group_id_status_idx"
ON "transcript_workspace"("workflow_group_id", "status");

-- At most one live workspace per recording. Partial, so the exceptional
-- archive-and-recreate path keeps every abandoned workspace for audit.
-- Prisma cannot express a partial unique index, so it is not declared in
-- schema.prisma; `prisma migrate dev` will report it as drift.
CREATE UNIQUE INDEX "transcript_workspace_live_per_recording_key"
ON "transcript_workspace"("workflow_group_id", "audio_hash")
WHERE "status" <> 'ARCHIVED';

CREATE TABLE "transcript_span" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "start_seconds" DOUBLE PRECISION NOT NULL,
    "end_seconds" DOUBLE PRECISION NOT NULL,
    "original_text" TEXT NOT NULL,
    "original_text_hash" VARCHAR(64) NOT NULL,
    "current_revision_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_span_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_span_ordinal_check" CHECK ("ordinal" >= 0),
    CONSTRAINT "transcript_span_bounds_check" CHECK ("end_seconds" >= "start_seconds")
);

CREATE UNIQUE INDEX "transcript_span_workspace_id_ordinal_key"
ON "transcript_span"("workspace_id", "ordinal");

CREATE INDEX "transcript_span_workspace_id_start_seconds_idx"
ON "transcript_span"("workspace_id", "start_seconds");

CREATE TABLE "transcript_span_revision" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "text_hash" VARCHAR(64) NOT NULL,
    "previous_revision_id" UUID,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_span_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_span_revision_text_hash_check" CHECK ("text_hash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "transcript_span_revision_span_id_created_at_idx"
ON "transcript_span_revision"("span_id", "created_at");

CREATE INDEX "transcript_span_revision_workspace_id_idx"
ON "transcript_span_revision"("workspace_id");

CREATE TABLE "transcript_span_decision" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "TranscriptDecisionKind" NOT NULL,
    "idempotency_key" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_span_decision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transcript_span_decision_workspace_id_user_id_idempotency_k_key"
ON "transcript_span_decision"("workspace_id", "user_id", "idempotency_key");

CREATE INDEX "transcript_span_decision_revision_id_user_id_created_at_idx"
ON "transcript_span_decision"("revision_id", "user_id", "created_at");

CREATE INDEX "transcript_span_decision_span_id_created_at_idx"
ON "transcript_span_decision"("span_id", "created_at");

CREATE TABLE "transcript_span_comment" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_span_comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_span_comment_body_check" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "transcript_span_comment_span_id_created_at_idx"
ON "transcript_span_comment"("span_id", "created_at");

CREATE TABLE "transcript_publication" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "status" "TranscriptPublicationStatus" NOT NULL DEFAULT 'PENDING',
    "required_approvals" INTEGER NOT NULL DEFAULT 2,
    "guide_revision_id" UUID,
    "published_by" TEXT,
    "span_count" INTEGER NOT NULL DEFAULT 0,
    "duration_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transcript_fingerprint" VARCHAR(64),
    "previous_source_kind" VARCHAR(16),
    "previous_source_ref" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "activating_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "transcript_publication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transcript_publication_required_approvals_check" CHECK ("required_approvals" >= 2)
);

CREATE INDEX "transcript_publication_workspace_id_created_at_idx"
ON "transcript_publication"("workspace_id", "created_at");

CREATE INDEX "transcript_publication_workflow_group_id_audio_hash_status_idx"
ON "transcript_publication"("workflow_group_id", "audio_hash", "status");

-- One publication at a time per workspace holds the write lock.
CREATE UNIQUE INDEX "transcript_publication_in_flight_per_workspace_key"
ON "transcript_publication"("workspace_id")
WHERE "status" IN ('PENDING', 'ACTIVATING');

CREATE TABLE "transcript_publication_span" (
    "publication_id" UUID NOT NULL,
    "span_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "transcript_publication_span_pkey" PRIMARY KEY ("publication_id", "span_id")
);

CREATE INDEX "transcript_publication_span_publication_id_ordinal_idx"
ON "transcript_publication_span"("publication_id", "ordinal");

ALTER TABLE "transcript_guide_revision"
ADD CONSTRAINT "transcript_guide_revision_workflow_group_id_fkey"
FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_guide_revision"
ADD CONSTRAINT "transcript_guide_revision_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_workspace"
ADD CONSTRAINT "transcript_workspace_workflow_group_id_fkey"
FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_workspace"
ADD CONSTRAINT "transcript_workspace_started_by_fkey"
FOREIGN KEY ("started_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_workspace"
ADD CONSTRAINT "transcript_workspace_archived_by_fkey"
FOREIGN KEY ("archived_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_span"
ADD CONSTRAINT "transcript_span_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_revision"
ADD CONSTRAINT "transcript_span_revision_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_revision"
ADD CONSTRAINT "transcript_span_revision_span_id_fkey"
FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_revision"
ADD CONSTRAINT "transcript_span_revision_previous_revision_id_fkey"
FOREIGN KEY ("previous_revision_id") REFERENCES "transcript_span_revision"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "transcript_span_revision"
ADD CONSTRAINT "transcript_span_revision_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_span"
ADD CONSTRAINT "transcript_span_current_revision_id_fkey"
FOREIGN KEY ("current_revision_id") REFERENCES "transcript_span_revision"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "transcript_span_decision"
ADD CONSTRAINT "transcript_span_decision_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_decision"
ADD CONSTRAINT "transcript_span_decision_span_id_fkey"
FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_decision"
ADD CONSTRAINT "transcript_span_decision_revision_id_fkey"
FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_decision"
ADD CONSTRAINT "transcript_span_decision_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_comment"
ADD CONSTRAINT "transcript_span_comment_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_comment"
ADD CONSTRAINT "transcript_span_comment_span_id_fkey"
FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_comment"
ADD CONSTRAINT "transcript_span_comment_revision_id_fkey"
FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_span_comment"
ADD CONSTRAINT "transcript_span_comment_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_publication"
ADD CONSTRAINT "transcript_publication_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_publication"
ADD CONSTRAINT "transcript_publication_guide_revision_id_fkey"
FOREIGN KEY ("guide_revision_id") REFERENCES "transcript_guide_revision"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_publication"
ADD CONSTRAINT "transcript_publication_published_by_fkey"
FOREIGN KEY ("published_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_publication_span"
ADD CONSTRAINT "transcript_publication_span_publication_id_fkey"
FOREIGN KEY ("publication_id") REFERENCES "transcript_publication"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_publication_span"
ADD CONSTRAINT "transcript_publication_span_span_id_fkey"
FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_publication_span"
ADD CONSTRAINT "transcript_publication_span_revision_id_fkey"
FOREIGN KEY ("revision_id") REFERENCES "transcript_span_revision"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transcript_workspace"
ADD CONSTRAINT "transcript_workspace_reader_publication_id_fkey"
FOREIGN KEY ("reader_publication_id") REFERENCES "transcript_publication"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "transcript_workspace"
ADD CONSTRAINT "transcript_workspace_search_publication_id_fkey"
FOREIGN KEY ("search_publication_id") REFERENCES "transcript_publication"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;
