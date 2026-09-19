ALTER TYPE "AuditAction" ADD VALUE 'EVENT_POSTER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'EVENT_POSTER_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'EVENT_POSTER_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'EVENT_POSTER_UNPUBLISHED';

CREATE TABLE "catalog_event_poster" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" INTEGER NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "label" VARCHAR(255),
    "square_extension" VARCHAR(8) NOT NULL,
    "square_original_name" VARCHAR(255) NOT NULL,
    "square_bytes" INTEGER NOT NULL,
    "square_sha256" VARCHAR(64) NOT NULL,
    "landscape_extension" VARCHAR(8) NOT NULL,
    "landscape_original_name" VARCHAR(255) NOT NULL,
    "landscape_bytes" INTEGER NOT NULL,
    "landscape_sha256" VARCHAR(64) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_event_poster_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_event_poster_square_bytes_check" CHECK ("square_bytes" > 0),
    CONSTRAINT "catalog_event_poster_landscape_bytes_check" CHECK ("landscape_bytes" > 0),
    CONSTRAINT "catalog_event_poster_square_sha256_check" CHECK ("square_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "catalog_event_poster_landscape_sha256_check" CHECK ("landscape_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "catalog_event_poster_id_event_id_workflow_group_id_key"
ON "catalog_event_poster"("id", "event_id", "workflow_group_id");

CREATE INDEX "catalog_event_poster_workflow_group_id_event_id_created_at_idx"
ON "catalog_event_poster"("workflow_group_id", "event_id", "created_at");

CREATE TABLE "catalog_event_poster_publication" (
    "event_id" INTEGER NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "poster_id" UUID NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_event_poster_publication_pkey" PRIMARY KEY ("workflow_group_id", "event_id")
);

CREATE UNIQUE INDEX "catalog_event_poster_publication_poster_id_key"
ON "catalog_event_poster_publication"("poster_id");

CREATE UNIQUE INDEX "catalog_event_poster_publication_event_id_workflow_group_id_key"
ON "catalog_event_poster_publication"("event_id", "workflow_group_id");

CREATE UNIQUE INDEX "catalog_event_poster_publication_poster_id_event_id_workflow_group_id_key"
ON "catalog_event_poster_publication"("poster_id", "event_id", "workflow_group_id");

ALTER TABLE "catalog_event_poster"
ADD CONSTRAINT "catalog_event_poster_event_id_workflow_group_id_fkey"
FOREIGN KEY ("event_id", "workflow_group_id")
REFERENCES "catalog_event"("id", "workflow_group_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_event_poster"
ADD CONSTRAINT "catalog_event_poster_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalog_event_poster_publication"
ADD CONSTRAINT "catalog_event_poster_publication_event_id_workflow_group_id_fkey"
FOREIGN KEY ("event_id", "workflow_group_id")
REFERENCES "catalog_event"("id", "workflow_group_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_event_poster_publication"
ADD CONSTRAINT "catalog_event_poster_publication_poster_id_event_id_workflow_group_id_fkey"
FOREIGN KEY ("poster_id", "event_id", "workflow_group_id")
REFERENCES "catalog_event_poster"("id", "event_id", "workflow_group_id")
ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "catalog_event_poster_publication"
ADD CONSTRAINT "catalog_event_poster_publication_published_by_fkey"
FOREIGN KEY ("published_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
