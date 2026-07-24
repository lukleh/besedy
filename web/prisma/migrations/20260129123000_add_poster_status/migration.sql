-- Add poster status index for fast catalog filtering/sorting
CREATE TABLE "poster_status" (
  "workflow_group_id" VARCHAR(15) NOT NULL,
  "audio_hash" VARCHAR(64) NOT NULL,
  "portrait" BOOLEAN NOT NULL DEFAULT false,
  "landscape" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "poster_status_pkey" PRIMARY KEY ("workflow_group_id", "audio_hash"),
  CONSTRAINT "poster_status_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE
);
