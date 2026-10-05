# Renaming a transcript backend key

A backend key (`{workflow}/{model component}`, for example
`faster-whisper/large-v3@silero_vad_v6@lang-cs`) names a transcript directory,
a ColBERT search scope and `RAG_BACKEND_KEY`. Changing it moves all of those,
and also three database columns that store the key as text. This is the
procedure for any rename, with or without correction data. The September 2026
`@lang-cs` cutover (#256) was the worked example; its one-time path tool is in
git history (`git log -- scripts/migrate_czech_transcript_paths.py`).

## What is stored, and what a rename does to it

| Stored in | Holds | Effect of a stale value |
| --------- | ----- | ----------------------- |
| `transcript_backend_priority.backend` | the admin ordering of backends | the backend loses its priority and falls back to the default order |
| `transcript_workspace.source_backend` | the backend a correction was frozen from | a stale label on the correction page and the original-transcript download, and in the audit payload of new publications |
| `transcript_publication.previous_source_ref` (when `previous_source_kind = 'machine'`) | the same key, as the source to restore on rollback | `completeIndexSync` compares it with the live `RAG_BACKEND_KEY`; a stale value makes a rollback to machine text count as complete even if the sync removed the correction and indexed nothing |

A frozen workspace is **not** stranded by a rename. Its source transcript is a
copy in the corrections directory (`resolveWorkspaceSourcePath`), published
corrections are indexed by audio hash, and the `backend` field of the correction
index pointer files is informational. So the work is rewriting three columns,
not moving correction data. The audit log keeps the old key, as history.

## Procedure

1. Pause the pipeline and the ingest worker, wait for running transcription
   and indexing runs to finish, and stop every web reader that shares the
   transcript and ColBERT roots (production and development). Back up the
   transcript trees and the database, and record the current
   `RAG_BACKEND_KEY` values for rollback. In every timestamped transcript
   generation, rename the model-component directory. Rebuild the search scope
   under the new key with
   `just catalog rag-colbert-index --group <id> --backend <new key> --rebuild`;
   the old scope can stay for rollback. Before the database step, confirm no
   correction publication is `PENDING`, `ACTIVATING` or `ROLLING_BACK`: one
   that completes between the rewrite and the env change would be judged
   against the wrong key.
2. In the same maintenance window, rewrite the stored keys with one
   transaction, as the application role. It updates all three columns, refuses
   an identical pair of keys, and refuses when the priority table already has a
   row for the new key (merge those by hand first):

```bash
bash scripts/run_web_compose.sh production exec -T db psql -U besedy_app -d besedy \
  -v ON_ERROR_STOP=1 \
  -v old_key='faster-whisper/large-v3@silero_vad_v6' \
  -v new_key='faster-whisper/large-v3@silero_vad_v6@lang-cs' \
  -f - < scripts/rename_transcript_backend_key.sql
```

   Run it once per key; each run is its own transaction. It prints the row
   count of each `UPDATE`; a second run updates nothing, so if one key of
   several fails (for example on the priority-conflict check), fix the cause
   and run the failed key again. Without both variables it exits with an error. Run the development database the same way
   (`development` instead of `production`).
3. Set `RAG_BACKEND_KEY` to the new key in the production and development web
   env files and the host worker env file, and restart them from the new
   revision. The test stack has its own transcript tree: regenerate its
   fixtures (`cd web && npm run test:e2e:generate`) and set the same key in its
   env file. Resume the pipeline and the ingest worker once search works under
   the new key.

To roll back, run the script again with the keys swapped, rename the
directories back, and restore the recorded `RAG_BACKEND_KEY` values.

The web app lists every model-component directory as a backend, so a
directory left under the old name shows up as a separate backend.

## Check

```sql
SELECT backend, priority FROM transcript_backend_priority ORDER BY backend;
SELECT source_backend, count(*) FROM transcript_workspace GROUP BY 1;
SELECT previous_source_ref, count(*) FROM transcript_publication
WHERE previous_source_kind = 'machine' GROUP BY 1;
```

None of the old key should remain. Also confirm the configured backend's
transcript count matches the count before the rename, and that a search and a
transcript read work. `tests/test_rename_transcript_backend_key.py`
fails when a Prisma column that stores a backend key is missing from the
script, so add new such columns to both.
