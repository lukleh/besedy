-- Decisions and comments are immutable history. Deleting a user must not erase
-- them: span state is derived from decisions, so a cascade would retroactively
-- drop a published span below two approvals while its publication stayed
-- active.
--
-- The actor is therefore recorded twice: `actor_key` is the immutable identity
-- the two-distinct-people rule counts, and `user_id` is the live relation,
-- nullable so deletion can clear it. Nulling `user_id` alone would merge every
-- deleted account into one counted participant.

ALTER TABLE "transcript_span_decision" ADD COLUMN "actor_key" TEXT;
UPDATE "transcript_span_decision" SET "actor_key" = "user_id" WHERE "actor_key" IS NULL;
ALTER TABLE "transcript_span_decision" ALTER COLUMN "actor_key" SET NOT NULL;
ALTER TABLE "transcript_span_decision" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "transcript_span_comment" ADD COLUMN "actor_key" TEXT;
UPDATE "transcript_span_comment" SET "actor_key" = "author_id" WHERE "actor_key" IS NULL;
ALTER TABLE "transcript_span_comment" ALTER COLUMN "actor_key" SET NOT NULL;
ALTER TABLE "transcript_span_comment" ALTER COLUMN "author_id" DROP NOT NULL;

ALTER TABLE "transcript_span_decision"
DROP CONSTRAINT "transcript_span_decision_user_id_fkey";

ALTER TABLE "transcript_span_decision"
ADD CONSTRAINT "transcript_span_decision_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transcript_span_comment"
DROP CONSTRAINT "transcript_span_comment_author_id_fkey";

ALTER TABLE "transcript_span_comment"
ADD CONSTRAINT "transcript_span_comment_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Idempotency and decision lookup follow the immutable identity, so a retry
-- still collides after the account behind it is gone.
DROP INDEX "transcript_span_decision_workspace_id_user_id_idempotency_k_key";
CREATE UNIQUE INDEX "transcript_span_decision_workspace_id_actor_key_idempotency_key"
ON "transcript_span_decision"("workspace_id", "actor_key", "idempotency_key");

DROP INDEX "transcript_span_decision_revision_id_user_id_created_at_idx";
CREATE INDEX "transcript_span_decision_revision_id_actor_key_created_at_idx"
ON "transcript_span_decision"("revision_id", "actor_key", "created_at");
