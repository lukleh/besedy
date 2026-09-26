-- Decisions are reduced per person to the one that came last. created_at has
-- millisecond precision, so two of one person's decisions can tie; the
-- sequence records the write order instead. Existing rows are numbered in
-- physical order, which for a table only ever appended to under the workspace
-- lock is their write order.
ALTER TABLE "transcript_span_decision" ADD COLUMN "sequence" BIGSERIAL NOT NULL;
