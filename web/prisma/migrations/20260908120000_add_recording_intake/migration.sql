-- CreateEnum
CREATE TYPE "RecordingIntakeStatus" AS ENUM ('UPLOADING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'REJECTED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'RECORDING_INGEST_REQUESTED';

-- CreateTable
CREATE TABLE "recording_intake" (
    "id" TEXT NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_filename" TEXT NOT NULL,
    "mime_type" TEXT,
    "expected_size_bytes" BIGINT NOT NULL,
    "received_bytes" BIGINT NOT NULL DEFAULT 0,
    "received_chunks" INTEGER NOT NULL DEFAULT 0,
    "status" "RecordingIntakeStatus" NOT NULL DEFAULT 'UPLOADING',
    "job_id" UUID,
    "audio_hash" VARCHAR(64),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "recording_intake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recording_intake_job_id_key" ON "recording_intake"("job_id");

-- CreateIndex
CREATE INDEX "recording_intake_workflow_group_id_status_idx" ON "recording_intake"("workflow_group_id", "status");

-- CreateIndex
CREATE INDEX "recording_intake_created_at_idx" ON "recording_intake"("created_at");

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

