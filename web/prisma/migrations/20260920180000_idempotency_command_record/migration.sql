-- An idempotency key names one command, not "whatever this person sends next".
-- The decision kind cannot name it on its own: an edit and a bare approval both
-- store APPROVE, so replaying an edit under an earlier approval's key silently
-- discarded the new text, and two edits carrying different text looked like a
-- retry of each other.
--
-- Nullable because rows written before this column existed have no command
-- recorded; a replay is only recognized when the stored command matches.

ALTER TABLE "transcript_span_decision" ADD COLUMN "command_name" VARCHAR(32);
ALTER TABLE "transcript_span_decision" ADD COLUMN "command_digest" VARCHAR(64);
