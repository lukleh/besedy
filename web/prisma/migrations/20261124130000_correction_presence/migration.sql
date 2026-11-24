BEGIN;

-- Who has a correction workspace open right now, and on which span. Advisory
-- only: rows expire by seen_at and no write checks them, so this is not
-- correction data and deleting it loses nothing.

-- CreateTable
CREATE TABLE "transcript_workspace_presence" (
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "span_id" UUID,
    "editing" BOOLEAN NOT NULL DEFAULT false,
    "seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_workspace_presence_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- AddForeignKey
ALTER TABLE "transcript_workspace_presence" ADD CONSTRAINT "transcript_workspace_presence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_workspace_presence" ADD CONSTRAINT "transcript_workspace_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_workspace_presence" ADD CONSTRAINT "transcript_workspace_presence_span_id_fkey" FOREIGN KEY ("span_id") REFERENCES "transcript_span"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
