-- Withdrawing corrected text from search touches PostgreSQL and the
-- filesystem, which cannot commit together. Doing the unlink inside the
-- transaction made the operation safe against concurrent writers and unsafe
-- against a crash: the transaction could roll back while the pointer stayed
-- deleted, leaving the database naming a correction that search no longer had
-- — a reader newer than search, the one direction this design forbids.
--
-- The intent is therefore committed first and cleared last, so every crash
-- point leaves search holding the correction the reader has already released.

ALTER TABLE "transcript_workspace" ADD COLUMN "search_withdrawal_at" TIMESTAMP(3);
