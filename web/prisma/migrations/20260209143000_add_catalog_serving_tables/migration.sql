-- Add DB-backed catalog serving tables and sync state

CREATE TYPE "CatalogSyncStatus" AS ENUM ('SUCCESS', 'ERROR');

CREATE TABLE "catalog_entry" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "compressed_path" TEXT,
  "original_path" TEXT,
  "filename" TEXT,
  "scan_root" TEXT,
  "duration_hms" VARCHAR(8),
  "source_title" TEXT,
  "source_artist" TEXT,
  "source_album" TEXT,
  "source_date" TEXT,
  "source_metadata_payload" JSONB,
  "source_archived_payload" JSONB,
  "details_payload_version" INTEGER NOT NULL DEFAULT 1,
  "has_archived" BOOLEAN NOT NULL,
  "has_metadata" BOOLEAN NOT NULL,
  "is_actionable" BOOLEAN NOT NULL,
  "duplicate_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_entry_pkey" PRIMARY KEY ("workflow_group_id", "audio_hash"),
  CONSTRAINT "catalog_entry_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE
);

CREATE INDEX "catalog_entry_workflow_group_id_is_actionable_idx" ON "catalog_entry"("workflow_group_id", "is_actionable");
CREATE INDEX "catalog_entry_workflow_group_id_source_artist_idx" ON "catalog_entry"("workflow_group_id", "source_artist");
CREATE INDEX "catalog_entry_workflow_group_id_source_date_idx" ON "catalog_entry"("workflow_group_id", "source_date");
CREATE INDEX "catalog_entry_workflow_group_id_duplicate_count_idx" ON "catalog_entry"("workflow_group_id", "duplicate_count");

CREATE TABLE "catalog_duplicate" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "original_path" TEXT NOT NULL,
  "duplicate_path" TEXT NOT NULL,
  "duplicate_payload" JSONB,
  "duplicate_payload_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_duplicate_pkey" PRIMARY KEY ("workflow_group_id", "audio_hash", "duplicate_path"),
  CONSTRAINT "catalog_duplicate_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE
);

CREATE INDEX "catalog_duplicate_workflow_group_id_audio_hash_idx" ON "catalog_duplicate"("workflow_group_id", "audio_hash");

CREATE TABLE "catalog_listening_entry" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "variant" VARCHAR(50) NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "compressed_path" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_listening_entry_pkey" PRIMARY KEY ("workflow_group_id", "variant", "audio_hash"),
  CONSTRAINT "catalog_listening_entry_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE,
  CONSTRAINT "catalog_listening_entry_workflow_group_id_variant_fkey" FOREIGN KEY ("workflow_group_id", "variant") REFERENCES "workflow_variant"("workflow_group_id", "variant") ON DELETE CASCADE
);

CREATE INDEX "catalog_listening_entry_workflow_group_id_audio_hash_idx" ON "catalog_listening_entry"("workflow_group_id", "audio_hash");

CREATE TABLE "catalog_sync_state" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "source_key" TEXT NOT NULL,
  "file_path" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "synced_at" TIMESTAMP(3) NOT NULL,
  "status" "CatalogSyncStatus" NOT NULL,
  "last_error" TEXT,

  CONSTRAINT "catalog_sync_state_pkey" PRIMARY KEY ("workflow_group_id", "source_key"),
  CONSTRAINT "catalog_sync_state_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE
);
