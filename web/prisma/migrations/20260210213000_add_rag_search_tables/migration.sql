-- Add RAG chunk storage and ingest observability tables.
-- Prerequisite: pgvector extension must be available on PostgreSQL runtime image.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "RagIngestRunStatus" AS ENUM (
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "rag_ingest_run" (
  "id" BIGSERIAL NOT NULL,
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "backend_key" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "transcripts_root" TEXT NOT NULL,
  "transcripts_manifest_hash" VARCHAR(64) NOT NULL,
  "chunk_version" VARCHAR(16) NOT NULL,
  "min_chunk_tokens" INTEGER NOT NULL,
  "max_chunk_tokens" INTEGER NOT NULL,
  "overlap_tokens" INTEGER NOT NULL,
  "embedding_provider" VARCHAR(64) NOT NULL,
  "embedding_model" TEXT NOT NULL,
  "run_fingerprint" VARCHAR(64) NOT NULL,
  "status" "RagIngestRunStatus" NOT NULL,
  "transcript_files" INTEGER NOT NULL DEFAULT 0,
  "transcripts_skipped" INTEGER NOT NULL DEFAULT 0,
  "chunks_indexed" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),

  CONSTRAINT "rag_ingest_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_ingest_run_workflow_group_id_fkey"
    FOREIGN KEY ("workflow_group_id")
    REFERENCES "workflow_group"("id")
    ON DELETE CASCADE
);

CREATE INDEX "rag_ingest_run_workflow_group_id_backend_key_created_at_idx"
  ON "rag_ingest_run"("workflow_group_id", "backend_key", "created_at" DESC);

CREATE TABLE "rag_chunk" (
  "chunk_id" VARCHAR(64) NOT NULL,
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "backend_key" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "start_sec" DOUBLE PRECISION NOT NULL,
  "end_sec" DOUBLE PRECISION NOT NULL,
  "chunk_version" VARCHAR(16) NOT NULL,
  "token_count" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "lex_tsv" tsvector NOT NULL,
  "embedding_model" TEXT NOT NULL,
  "embedding_model_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rag_chunk_pkey" PRIMARY KEY ("chunk_id"),
  CONSTRAINT "rag_chunk_workflow_group_id_fkey"
    FOREIGN KEY ("workflow_group_id")
    REFERENCES "workflow_group"("id")
    ON DELETE CASCADE
);

CREATE INDEX "rag_chunk_workflow_group_id_backend_key_idx"
  ON "rag_chunk"("workflow_group_id", "backend_key");

CREATE INDEX "rag_chunk_audio_hash_start_sec_idx"
  ON "rag_chunk"("audio_hash", "start_sec");

CREATE INDEX "rag_chunk_embedding_hnsw_idx"
  ON "rag_chunk"
  USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "rag_chunk_lex_tsv_gin_idx"
  ON "rag_chunk"
  USING GIN ("lex_tsv");
