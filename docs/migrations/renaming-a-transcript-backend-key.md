# Renaming a transcript backend key

A backend key (`{workflow}/{model component}`, for example
`faster-whisper/large-v3@silero_vad_v6@lang-cs`) names a transcript directory,
a ColBERT search scope and `RAG_BACKEND_KEY`. Changing it moves all of those,
and also three database columns that store the key as text. This is the
procedure for a rename when correction data exists. The
[explicit Czech paths migration](explicit-czech-transcript-paths.md) is the
worked example of the directory and index steps.

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

1. Do the directory move, the index rebuild and the env changes of the rename
   as in the Czech paths migration (pause writers, back up, move the
   transcript directories, rebuild the search scope under the new key).
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

   Run it once per key. It prints the row count of each `UPDATE`; a second run
   updates nothing. Run the development database the same way
   (`development` instead of `production`).
3. Set `RAG_BACKEND_KEY` to the new key in the web and worker env files, as in
   the migration, and restart.

To roll back, run the script again with the keys swapped, together with the
directory and env rollback.

## Check

```sql
SELECT backend, priority FROM transcript_backend_priority ORDER BY backend;
SELECT source_backend, count(*) FROM transcript_workspace GROUP BY 1;
SELECT previous_source_ref, count(*) FROM transcript_publication
WHERE previous_source_kind = 'machine' GROUP BY 1;
```

None of the old key should remain. `tests/test_rename_transcript_backend_key.py`
fails when a Prisma column that stores a backend key is missing from the
script, so add new such columns to both.
