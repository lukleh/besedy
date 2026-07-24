-- Event publish notifications fire immediately on first release.

ALTER TABLE "catalog_event"
ADD COLUMN "published_notified_at" TIMESTAMP(3);

UPDATE "catalog_event"
SET "published_notified_at" = CURRENT_TIMESTAMP
WHERE "released" = true
  AND "published_notified_at" IS NULL;

CREATE TABLE "event_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "event_id" INTEGER NOT NULL,
    "title" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_notifications_user_id_catalog_id_event_id_key"
ON "event_notifications"("user_id", "catalog_id", "event_id");

CREATE INDEX "event_notifications_user_id_is_read_idx"
ON "event_notifications"("user_id", "is_read");

CREATE INDEX "event_notifications_catalog_id_event_id_idx"
ON "event_notifications"("catalog_id", "event_id");

ALTER TABLE "event_notifications"
ADD CONSTRAINT "event_notifications_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "event_notifications"
ADD CONSTRAINT "event_notifications_catalog_id_fkey"
FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "event_notifications"
ADD CONSTRAINT "event_notifications_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "catalog_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
