-- Add event catalog tables

CREATE TABLE "catalog_event" (
  "id" SERIAL NOT NULL,
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "title" TEXT,
  "location_id" INTEGER NOT NULL,
  "date_year" INTEGER NOT NULL,
  "date_month" INTEGER,
  "date_day" INTEGER,
  "description" TEXT,
  "released" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "catalog_event_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE,
  CONSTRAINT "catalog_event_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "catalog_event_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "catalog_event_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Required as composite FK target in catalog_event_recording
CREATE UNIQUE INDEX "catalog_event_id_workflow_group_id_key" ON "catalog_event"("id", "workflow_group_id");

CREATE TABLE "catalog_event_recording" (
  "event_id" INTEGER NOT NULL,
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_event_recording_pkey" PRIMARY KEY ("workflow_group_id", "audio_hash"),
  CONSTRAINT "catalog_event_recording_event_id_workflow_group_id_fkey" FOREIGN KEY ("event_id", "workflow_group_id") REFERENCES "catalog_event"("id", "workflow_group_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "catalog_event_recording_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Future non-admin listing
CREATE INDEX "catalog_event_workflow_group_id_released_idx" ON "catalog_event"("workflow_group_id", "released");

-- Null-safe event identity (Prisma cannot express this index directly)
CREATE UNIQUE INDEX "catalog_event_identity_idx" ON "catalog_event" (
  "workflow_group_id",
  "location_id",
  "date_year",
  COALESCE("date_month", 0),
  COALESCE("date_day", 0)
);

-- At most one primary recording per event (Prisma cannot express partial unique index)
CREATE UNIQUE INDEX "catalog_event_recording_primary_idx" ON "catalog_event_recording" ("event_id")
WHERE "is_primary" = true;
