BEGIN;

-- Command the host ingest worker runs after a successful ingest, edited by
-- admins on the ingest page.

-- AlterTable
ALTER TABLE "workflow_group" ADD COLUMN     "ingest_post_command" TEXT;

COMMIT;
