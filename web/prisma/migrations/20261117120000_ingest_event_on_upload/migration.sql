BEGIN;

-- Where and when an uploaded recording took place, and the event it was
-- assigned to once the ingest succeeded.

-- AlterTable
ALTER TABLE "recording_intake" ADD COLUMN     "date_day" INTEGER,
ADD COLUMN     "date_month" INTEGER,
ADD COLUMN     "date_year" INTEGER,
ADD COLUMN     "event_id" INTEGER,
ADD COLUMN     "location_id" INTEGER;

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_intake" ADD CONSTRAINT "recording_intake_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "catalog_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
