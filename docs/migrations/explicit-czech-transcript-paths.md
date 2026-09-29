# Explicit Czech transcript paths

This migration changes forced-Czech transcript variants from an unsuffixed
model component to `@lang-cs`. It applies to every timestamped transcript
generation, including archived generations, and every Czech transcription
workflow. `@lang-auto` remains a separate automatic-detection mode.

The directory move is in-place and does not modify transcript bytes. Derived
`transcripts_merged_*/*/slots.json` files record model keys, so the tool can
update those labels too. The ColBERT scope and chunk IDs include the backend
key, so the search bundle for the new key must be rebuilt. The old bundle can
remain in place for rollback.

## Preflight

1. Deploy the code that writes `@lang-cs` before allowing another transcription
   run. Pause the pipeline and ingest worker, and wait for active transcription
   and indexing runs to finish before paths and the index change.
   Stop every web reader that shares the transcript and ColBERT roots, including
   the running development stack, during the directory move and rebuild.
2. Back up the transcript and merged-transcript trees and database. Record the
   old `RAG_BACKEND_KEY` from the production and development web env files and
   the host worker env file. Production and development share the live
   transcript and index roots, so both active stacks must switch together.
   Test uses a separate transcript fixture tree; regenerate its fixtures and
   change its private backend key together before running E2E tests.
3. Confirm no correction workspace or publication is in flight. This procedure
   requires both `transcript_workspace` and `transcript_publication` to be empty;
   otherwise their frozen backend references and search paths need a separate
   data migration.
4. List timestamped roots beneath the configured transcript parent. Pass each
   root directly; do not pass the `transcripts` symlink or a merged transcript
   tree. The tool checks all destination paths before moving anything.

```bash
uv run python scripts/migrate_czech_transcript_paths.py \
  /path/to/transcripts/transcripts_20251222_144441 \
  /path/to/transcripts/transcripts_20260221_120320 \
  --merged-root /path/to/transcripts/transcripts_merged_20251222_144441
```

The tool recognizes `canary-nemo`, `faster-whisper`, `whisperx`, and `qwen3-asr`
workflow directories. Add `--workflow-label NAME` for a custom transcription
workflow label, and include that label in the backend-priority SQL below if it
has stored rows. It skips diarization and existing language-suffixed variants.
Resolve any `Both Czech variant paths exist` error before proceeding; the tool
never merges trees or overwrites a destination.

In PostgreSQL, record the rows before the cutover:

```sql
SELECT backend, priority FROM transcript_backend_priority ORDER BY backend;
SELECT count(*) FROM transcript_workspace;
SELECT count(*) FROM transcript_publication;
```

## Cutover

1. Run the same command with `--apply`. It renames the model-component
   directories and preserves every hash directory and sidecar. It also updates
   merged `slots.json` model labels when `--merged-root` is supplied. Re-running
   it after an interruption completes the remaining changes.
2. Update backend-priority rows in PostgreSQL. Check the counts first. With no
   correction rows, this transaction updates only unsuffixed transcription
   backend keys:

```sql
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM transcript_workspace)
     OR EXISTS (SELECT 1 FROM transcript_publication) THEN
    RAISE EXCEPTION 'Correction data requires a separate migration';
  END IF;
END $$;
UPDATE transcript_backend_priority
SET backend = backend || '@lang-cs', updated_at = NOW()
WHERE split_part(backend, '/', 1) IN
  ('canary-nemo', 'faster-whisper', 'whisperx', 'qwen3-asr')
  AND backend !~ '@lang-[^/@]+$';
COMMIT;
```

3. Rebuild each required search scope. For the production default shown below,
   pass the new key explicitly so an old environment value cannot select the
   old scope:

```bash
just catalog rag-colbert-index \
  --group 20251222_144441 \
  --backend faster-whisper/large-v3@silero_vad_v6@lang-cs \
  --rebuild
```

4. Set `RAG_BACKEND_KEY=faster-whisper/large-v3@silero_vad_v6@lang-cs` in the
   private production and development web env files and the host worker env
   file. Regenerate the test fixtures and set the test web env to the same key
   before starting the test stack; its transcript tree is separate.
   Restart active web stacks and the worker from the new revision. Resume
   ingestion after the new index is active. The repository example env files
   already use the new key.

   Regenerate test transcripts from the new revision with
   `cd web && npm run test:e2e:generate`; this writes fixture backends with
   `@lang-cs` and removes the old fixture tree.

## Verify and rollback

- Confirm the configured backend exists in the active transcript generation,
  and its transcript count equals the preflight count.
- Confirm the ColBERT resolver finds an active bundle under the new backend
  scope, then exercise search and a canonical transcript read.
- Confirm backend-priority rows, all active web stacks, and the host worker all
  name the same suffixed key. Check that no unsuffixed Czech variant directories
  remain in any migrated generation, and that merged slot model labels use the
  new key.

If cutover fails, keep writers paused, restore the old env values in production
and development and the host worker, restore the backend-priority rows, and
run the path tool with the same transcript roots, every `--merged-root` used
during cutover, and `--rollback --apply`. This also restores the merged
`slots.json` model labels. Restore the previous pipeline and host-worker code
revision before resuming transcription; the new revision always writes
`@lang-cs` paths. The old ColBERT scope remains available. A rollback dry run
omits `--apply`. To reverse only the priority-row change, use:

```sql
BEGIN;
UPDATE transcript_backend_priority
SET backend = left(backend, -length('@lang-cs')), updated_at = NOW()
WHERE split_part(backend, '/', 1) IN
  ('canary-nemo', 'faster-whisper', 'whisperx', 'qwen3-asr')
  AND backend LIKE '%@lang-cs';
COMMIT;
```
