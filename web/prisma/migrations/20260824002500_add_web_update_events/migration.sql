-- CreateEnum
CREATE TYPE "WebUpdateEventType" AS ENUM ('CLIENT_SEEN', 'UPDATE_DETECTED', 'WORKER_READY', 'UPDATE_DISMISSED', 'APPLY_REQUESTED', 'APPLY_BLOCKED', 'VERSION_PROBE_FAILED', 'ACTIVATION_STARTED', 'ACTIVATION_COMPLETE', 'RELOAD_FALLBACK', 'REGISTRATION_FAILED');

-- CreateTable
CREATE TABLE "web_update_event" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "event" "WebUpdateEventType" NOT NULL,
    "attempt_id" VARCHAR(64) NOT NULL,
    "client_version" VARCHAR(64),
    "target_version" VARCHAR(64),
    "worker_ready" BOOLEAN,
    "blocker_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "route_group" VARCHAR(40),
    "browser" VARCHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_update_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_update_event_created_at_idx" ON "web_update_event"("created_at");

-- CreateIndex
CREATE INDEX "web_update_event_event_created_at_idx" ON "web_update_event"("event", "created_at");

-- CreateIndex
CREATE INDEX "web_update_event_target_version_created_at_idx" ON "web_update_event"("target_version", "created_at");

-- CreateIndex
CREATE INDEX "web_update_event_attempt_id_idx" ON "web_update_event"("attempt_id");

-- AddForeignKey
ALTER TABLE "web_update_event" ADD CONSTRAINT "web_update_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
