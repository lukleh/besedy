-- A withdrawal needs an identity, not a time. A timestamp cannot tell one
-- attempt from another, so a delayed retry could remove a pointer written
-- after its own withdrawal had finished, or clear a later withdrawal's intent.
-- A token per generation lets each step check that it still owns the intent.
--
-- This arrives as its own migration rather than as an edit to
-- 20260920200000_withdrawal_intent, which has already been applied on branch
-- databases. Editing that file leaves them without the enum value the next
-- migration's index predicate needs, and `migrate deploy` then fails with
-- `invalid input value for enum "TranscriptPublicationStatus"` and has to be
-- recovered by hand.
--
-- The column is replaced rather than renamed: it changes from a time to an
-- identity, and the intent it carries is transient in a feature that has never
-- been released.

ALTER TABLE "transcript_workspace" DROP COLUMN IF EXISTS "search_withdrawal_at";
ALTER TABLE "transcript_workspace" ADD COLUMN IF NOT EXISTS "search_withdrawal_id" UUID;

-- Rollback has the same two-system boundary. Committing this state before the
-- previous pointer is restored makes a crash resumable, and stops web
-- resolution treating the abandoned publication as ACTIVATING. PostgreSQL
-- requires it to be committed before the next migration's index predicate can
-- name it, which is why that predicate lives in its own migration.
ALTER TYPE "TranscriptPublicationStatus" ADD VALUE IF NOT EXISTS 'ROLLING_BACK' BEFORE 'ROLLED_BACK';
