ALTER TABLE "rag_ingest_run"
  ADD COLUMN "target_audio_hash" VARCHAR(64),
  ADD COLUMN "hashes_discovered" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hashes_added" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hashes_updated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hashes_removed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hashes_unchanged" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hashes_failed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chunks_inserted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chunks_deleted" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "rag_source_state" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "backend_key" TEXT NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "transcript_path" TEXT NOT NULL,
  "transcript_fingerprint" VARCHAR(64) NOT NULL,
  "chunking_fingerprint" VARCHAR(64) NOT NULL,
  "embedding_fingerprint" VARCHAR(64) NOT NULL,
  "last_run_id" TEXT NOT NULL,
  "chunk_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rag_source_state_pkey"
    PRIMARY KEY ("workflow_group_id", "backend_key", "audio_hash"),
  CONSTRAINT "rag_source_state_workflow_group_id_fkey"
    FOREIGN KEY ("workflow_group_id")
    REFERENCES "workflow_group"("id")
    ON DELETE CASCADE
);

CREATE INDEX "rag_source_state_workflow_group_id_backend_key_idx"
  ON "rag_source_state"("workflow_group_id", "backend_key");
