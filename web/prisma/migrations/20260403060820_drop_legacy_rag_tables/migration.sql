/*
  Warnings:

  - You are about to drop the `rag_chunk` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `rag_ingest_run` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `rag_source_state` table. If the table is not empty, all the data it contains will be lost.

  Note:
  - This migration also normalizes pre-existing Prisma drift on several catalog-serving tables.
    The dropped `updated_at` defaults and re-created cascading foreign keys align the live
    database with the current Prisma schema (`@updatedAt` without DB defaults, `onDelete: Cascade`).
    They are not part of the ColBERT runtime cutover itself.

*/
-- DropForeignKey
ALTER TABLE "catalog_duplicate" DROP CONSTRAINT "catalog_duplicate_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_entry" DROP CONSTRAINT "catalog_entry_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_event" DROP CONSTRAINT "catalog_event_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_listening_entry" DROP CONSTRAINT "catalog_listening_entry_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_listening_entry" DROP CONSTRAINT "catalog_listening_entry_workflow_group_id_variant_fkey";

-- DropForeignKey
ALTER TABLE "catalog_sync_state" DROP CONSTRAINT "catalog_sync_state_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "rag_chunk" DROP CONSTRAINT "rag_chunk_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "rag_ingest_run" DROP CONSTRAINT "rag_ingest_run_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "rag_source_state" DROP CONSTRAINT "rag_source_state_workflow_group_id_fkey";

-- AlterTable
ALTER TABLE "catalog_duplicate" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "catalog_entry" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "catalog_event" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "catalog_event_recording" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "catalog_listening_entry" ALTER COLUMN "updated_at" DROP DEFAULT;

-- DropTable
DROP TABLE "rag_chunk";

-- DropTable
DROP TABLE "rag_ingest_run";

-- DropTable
DROP TABLE "rag_source_state";

-- DropEnum
DROP TYPE "RagIngestRunStatus";

-- AddForeignKey
ALTER TABLE "catalog_entry" ADD CONSTRAINT "catalog_entry_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_duplicate" ADD CONSTRAINT "catalog_duplicate_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_listening_entry" ADD CONSTRAINT "catalog_listening_entry_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_listening_entry" ADD CONSTRAINT "catalog_listening_entry_workflow_group_id_variant_fkey" FOREIGN KEY ("workflow_group_id", "variant") REFERENCES "workflow_variant"("workflow_group_id", "variant") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_sync_state" ADD CONSTRAINT "catalog_sync_state_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_event" ADD CONSTRAINT "catalog_event_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
