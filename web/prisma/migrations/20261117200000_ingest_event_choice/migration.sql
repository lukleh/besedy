BEGIN;

-- How an uploaded recording joins an event: the upload batch it belongs to,
-- an existing event chosen on upload, or a separate new event.

-- AlterTable
ALTER TABLE "recording_intake" ADD COLUMN     "create_distinct_event" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "target_event_id" INTEGER,
ADD COLUMN     "upload_batch_id" UUID;

-- CreateIndex
CREATE INDEX "recording_intake_upload_batch_id_idx" ON "recording_intake"("upload_batch_id");

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_target_event_id_fkey" FOREIGN KEY ("target_event_id") REFERENCES "catalog_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
