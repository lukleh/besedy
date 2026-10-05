-- Rename a transcript backend key in every table that stores it, in one
-- transaction. Run it together with the directory move and the RAG_BACKEND_KEY
-- change of a key rename (see docs/migrations/renaming-a-transcript-backend-key.md).
--
--   psql -v ON_ERROR_STOP=1 -v old_key='faster-whisper/large-v3@silero_vad_v6' \
--        -v new_key='faster-whisper/large-v3@silero_vad_v6@lang-cs' \
--        -f scripts/rename_transcript_backend_key.sql
--
-- Production, as the application role:
--   bash scripts/run_web_compose.sh production exec -T db psql -U besedy_app -d besedy \
--     -v ON_ERROR_STOP=1 -v old_key='...' -v new_key='...' -f - < scripts/rename_transcript_backend_key.sql
--
-- Stored in:
--   transcript_backend_priority.backend      the admin ordering of backends
--   transcript_workspace.source_backend      the backend a correction was frozen from
--   transcript_publication.previous_source_ref   the same key, when the effective
--                                            source before the publication was machine text
-- Not touched: the immutable audit log, and the `backend` field of the correction
-- index pointer files, which is informational (the index resolves a correction by
-- audio hash, not by that field).

\set ON_ERROR_STOP on

-- A missing variable is an error (non-zero exit), not a message: automation must
-- not read an unapplied rename as done.
\if :{?old_key}
\else
  \set old_key ''
\endif
\if :{?new_key}
\else
  \set new_key ''
\endif

BEGIN;

SELECT set_config('besedy.old_key', :'old_key', true), set_config('besedy.new_key', :'new_key', true);

DO $$
BEGIN
  IF current_setting('besedy.old_key') = '' OR current_setting('besedy.new_key') = '' THEN
    RAISE EXCEPTION 'Set both -v old_key=... and -v new_key=...';
  END IF;
  IF length(current_setting('besedy.old_key')) > 255 OR length(current_setting('besedy.new_key')) > 255 THEN
    RAISE EXCEPTION 'Backend keys are at most 255 characters';
  END IF;
  IF current_setting('besedy.old_key') = current_setting('besedy.new_key') THEN
    RAISE EXCEPTION 'old_key and new_key are the same';
  END IF;
  IF EXISTS (SELECT 1 FROM transcript_backend_priority WHERE backend = current_setting('besedy.new_key'))
     AND EXISTS (SELECT 1 FROM transcript_backend_priority WHERE backend = current_setting('besedy.old_key')) THEN
    RAISE EXCEPTION 'transcript_backend_priority already has a row for the new key; merge the rows by hand first';
  END IF;
END $$;

UPDATE transcript_backend_priority
SET backend = :'new_key', updated_at = NOW()
WHERE backend = :'old_key';

UPDATE transcript_workspace
SET source_backend = :'new_key'
WHERE source_backend = :'old_key';

UPDATE transcript_publication
SET previous_source_ref = :'new_key'
WHERE previous_source_kind = 'machine' AND previous_source_ref = :'old_key';

COMMIT;
