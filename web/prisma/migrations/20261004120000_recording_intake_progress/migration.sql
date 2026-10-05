-- Step the ingest worker has reached for a running ingest or removal (#348).
-- All nullable: rows from before this change, and runs from a worker that
-- does not report progress, keep showing the Prefect state name.
-- AlterTable
ALTER TABLE "recording_intake" ADD COLUMN     "progress_label" TEXT,
ADD COLUMN     "progress_step" INTEGER,
ADD COLUMN     "progress_step_started_at" TIMESTAMP(3),
ADD COLUMN     "progress_total" INTEGER,
ADD COLUMN     "started_at" TIMESTAMP(3);
