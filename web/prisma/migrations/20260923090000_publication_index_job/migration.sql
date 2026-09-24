-- Publication waits for the search index. The web application renders the
-- artifacts and writes the index pointer, then asks the host worker to run the
-- incremental ColBERT sync and reports back what the active bundle holds for
-- the recording. Only then do the database pointers move (ADR 0006).
--
-- `index_job_id` is the Prefect flow run carrying the sync; `search_source_path`
-- is the transcript the bundle recorded, which is checked against this
-- publication's artifact before the reader pointer moves. Withdrawal from
-- search runs through the same job, so the workspace records its run as well.

ALTER TABLE "transcript_publication" ADD COLUMN "index_job_id" UUID;
ALTER TABLE "transcript_publication" ADD COLUMN "index_requested_at" TIMESTAMP(3);
ALTER TABLE "transcript_publication" ADD COLUMN "search_source_path" TEXT;

ALTER TABLE "transcript_workspace" ADD COLUMN "search_withdrawal_job_id" UUID;
