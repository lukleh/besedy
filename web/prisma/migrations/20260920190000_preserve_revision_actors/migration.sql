-- Decisions and comments already keep an immutable actor. Revisions did not,
-- so deleting an editor left history unable to say who wrote a span's text --
-- which ADR 0006 asks it to make clear.
--
-- Null stays meaningful here: the revision imported from the frozen machine
-- source has no author, and never did.

ALTER TABLE "transcript_span_revision" ADD COLUMN "actor_key" TEXT;
UPDATE "transcript_span_revision" SET "actor_key" = "author_id" WHERE "author_id" IS NOT NULL;
