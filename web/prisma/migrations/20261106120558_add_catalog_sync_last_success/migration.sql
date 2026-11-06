-- AlterTable
ALTER TABLE "catalog_sync_state" ADD COLUMN     "last_successful_at" TIMESTAMP(3);

-- Successful rows have a known completion time. An error may have overwritten
-- an earlier success timestamp, so leave those historical values unknown.
UPDATE "catalog_sync_state"
SET "last_successful_at" = "synced_at"
WHERE "status" = 'SUCCESS';
