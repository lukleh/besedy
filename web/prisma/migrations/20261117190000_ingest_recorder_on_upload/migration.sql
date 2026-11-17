BEGIN;

-- Recorder entered on upload; it becomes the recording's metadata once the
-- ingest succeeds.

-- AlterTable
ALTER TABLE "recording_intake" ADD COLUMN     "recorder_id" INTEGER;

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_recorder_id_fkey" FOREIGN KEY ("recorder_id") REFERENCES "recorders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
