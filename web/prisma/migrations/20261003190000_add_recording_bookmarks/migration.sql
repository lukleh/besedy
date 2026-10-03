-- Private listener bookmarks: a timestamp and an optional comment in one
-- recording of one catalog.
CREATE TABLE "recording_bookmark" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "position_sec" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,
    "excerpt" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recording_bookmark_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recording_bookmark_user_id_workflow_group_id_audio_hash_idx"
ON "recording_bookmark"("user_id", "workflow_group_id", "audio_hash");

CREATE INDEX "recording_bookmark_workflow_group_id_audio_hash_idx"
ON "recording_bookmark"("workflow_group_id", "audio_hash");

ALTER TABLE "recording_bookmark"
ADD CONSTRAINT "recording_bookmark_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recording_bookmark"
ADD CONSTRAINT "recording_bookmark_workflow_group_id_fkey"
FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
