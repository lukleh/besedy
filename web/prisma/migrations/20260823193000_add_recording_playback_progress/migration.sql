CREATE TABLE "recording_playback_progress" (
    "user_id" TEXT NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "position_sec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration_sec" DOUBLE PRECISION,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recording_playback_progress_pkey" PRIMARY KEY ("user_id", "audio_hash")
);

CREATE INDEX "recording_playback_progress_user_id_updated_at_idx"
ON "recording_playback_progress"("user_id", "updated_at");

ALTER TABLE "recording_playback_progress"
ADD CONSTRAINT "recording_playback_progress_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
