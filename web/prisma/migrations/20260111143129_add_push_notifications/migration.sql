-- CreateTable
CREATE TABLE "ready_scan_state" (
    "id" SERIAL NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "known_ready_hashes" JSONB NOT NULL DEFAULT '[]',
    "state_hash" VARCHAR(64) NOT NULL,
    "last_scan_at" TIMESTAMP(3) NOT NULL,
    "ready_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ready_scan_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "title" TEXT,
    "batch_id" VARCHAR(36) NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" VARCHAR(255) NOT NULL,
    "auth" VARCHAR(64) NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ready_scan_state_catalog_id_key" ON "ready_scan_state"("catalog_id");

-- CreateIndex
CREATE INDEX "recording_notifications_user_id_is_read_idx" ON "recording_notifications"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "recording_notifications_batch_id_idx" ON "recording_notifications"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "recording_notifications_user_id_catalog_id_audio_hash_key" ON "recording_notifications"("user_id", "catalog_id", "audio_hash");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- AddForeignKey
ALTER TABLE "ready_scan_state" ADD CONSTRAINT "ready_scan_state_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_notifications" ADD CONSTRAINT "recording_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_notifications" ADD CONSTRAINT "recording_notifications_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
