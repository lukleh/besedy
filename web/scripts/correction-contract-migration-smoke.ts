/** Run against a disposable database migrated through the archive-field cleanup,
 * before require_current_correction_contract. Every scenario rolls back. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).pathname !== '/besedy_contract_migration_test'
) {
  throw new Error(
    'TEST_DATABASE_URL must select the disposable besedy_contract_migration_test database',
  );
}
const migration = readFileSync(
  path.resolve(
    __dirname,
    '../prisma/migrations/20261108224155_require_current_correction_contract/migration.sql',
  ),
  'utf8',
)
  .replace(/^BEGIN;\s*/, '')
  .replace(/COMMIT;\s*$/, '');
const db = new Client({ connectionString });
const oldWorkspace = '00000000-0000-4000-8000-000000000001';
const oldSpan = '00000000-0000-4000-8000-000000000002';
const oldRevision = '00000000-0000-4000-8000-000000000003';
const currentWorkspace = '00000000-0000-4000-8000-000000000004';
const guide = '00000000-0000-4000-8000-000000000005';

async function fixture() {
  await db.query(`
    INSERT INTO workflow_group(id,archived_catalog_path,metadata_catalog_path)
      VALUES ('20990101_000000','/archive.csv','/metadata.csv');
    INSERT INTO transcript_guide_revision(id,workflow_group_id,body)
      VALUES ('${guide}','20990101_000000','Guide');
    INSERT INTO transcript_workspace(id,workflow_group_id,audio_hash,source_backend,source_fingerprint,status,updated_at,archived_at,archive_reason)
      VALUES ('${oldWorkspace}','20990101_000000',repeat('a',64),'backend/model',repeat('b',64),'ARCHIVED',now(),now(),'Unused machine snapshot');
    INSERT INTO transcript_span(id,workspace_id,ordinal,start_seconds,end_seconds,original_text,original_text_hash,updated_at)
      VALUES ('${oldSpan}','${oldWorkspace}',0,0,1,'machine',repeat('c',64),now());
    INSERT INTO transcript_span_revision(id,workspace_id,span_id,text,text_hash)
      VALUES ('${oldRevision}','${oldWorkspace}','${oldSpan}','machine',repeat('c',64));
    UPDATE transcript_span SET current_revision_id='${oldRevision}' WHERE id='${oldSpan}';
    INSERT INTO transcript_workspace(id,workflow_group_id,audio_hash,source_backend,source_fingerprint,
      segmentation_version,segmentation_params,source_chunk_count,staged_audio_path,staged_audio_size,staged_audio_sha256,updated_at)
      VALUES ('${currentWorkspace}','20990101_000000',repeat('d',64),'backend/model',repeat('e',64),
      'chunks-v1','{"sampleRate":16000,"maxChunkSpeechSamples":480000,"splitGapSamples":16000,"maxSpanSamples":480000,"mergeBelowSamples":32000}',
      1,'/current.wav',32044,repeat('f',64),now());
  `);
}

const blockers = [
  [
    'active workspace',
    `UPDATE transcript_workspace SET status='ACTIVE',archived_at=NULL WHERE id='${oldWorkspace}'`,
  ],
  [
    'deleted author identity',
    `UPDATE transcript_span_revision SET actor_key='deleted-person' WHERE id='${oldRevision}'`,
  ],
  [
    'edited text',
    `UPDATE transcript_span_revision SET text='changed' WHERE id='${oldRevision}'`,
  ],
  [
    'decision',
    `INSERT INTO transcript_span_decision(id,workspace_id,span_id,revision_id,actor_key,kind)
    VALUES (gen_random_uuid(),'${oldWorkspace}','${oldSpan}','${oldRevision}','person','APPROVE')`,
  ],
  [
    'comment',
    `INSERT INTO transcript_span_comment(id,workspace_id,span_id,revision_id,actor_key,body)
    VALUES (gen_random_uuid(),'${oldWorkspace}','${oldSpan}','${oldRevision}','person','comment')`,
  ],
  [
    'flag',
    `INSERT INTO transcript_span_flag_event(id,workspace_id,span_id,actor_key,kind,action)
    VALUES (gen_random_uuid(),'${oldWorkspace}','${oldSpan}','person','UNCLEAR','SET')`,
  ],
  [
    'publication',
    `INSERT INTO transcript_publication(id,workspace_id,workflow_group_id,audio_hash,updated_at)
    VALUES (gen_random_uuid(),'${oldWorkspace}','20990101_000000',repeat('a',64),now())`,
  ],
  [
    'withdrawal intent',
    `UPDATE transcript_workspace SET search_withdrawal_id=gen_random_uuid() WHERE id='${oldWorkspace}'`,
  ],
] as const;

async function main() {
  await db.connect();
  try {
    for (const [label, mutation] of blockers) {
      await db.query('BEGIN');
      try {
        await fixture();
        await db.query(mutation);
        await db.query('SAVEPOINT migration');
        await assert.rejects(
          db.query(migration),
          /Refusing to retire pre-contract correction workspaces/,
        );
        await db.query('ROLLBACK TO SAVEPOINT migration');
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS count FROM transcript_span_revision WHERE id=$1',
              [oldRevision],
            )
          ).rows[0].count,
          1,
        );
        console.log(`ok: refuses ${label} and preserves its snapshot`);
      } finally {
        await db.query('ROLLBACK');
      }
    }
    await db.query('BEGIN');
    try {
      await fixture();
      const before = (
        await db.query(
          'SELECT to_jsonb(w) AS value FROM transcript_workspace w WHERE id=$1',
          [currentWorkspace],
        )
      ).rows[0].value;
      await db.query(migration);
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM transcript_workspace WHERE id=$1',
            [oldWorkspace],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM transcript_span WHERE id=$1',
            [oldSpan],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM transcript_span_revision WHERE id=$1',
            [oldRevision],
          )
        ).rows[0].count,
        0,
      );
      assert.deepEqual(
        (
          await db.query(
            'SELECT to_jsonb(w) AS value FROM transcript_workspace w WHERE id=$1',
            [currentWorkspace],
          )
        ).rows[0].value,
        before,
      );
      await db.query('SAVEPOINT invalid_version');
      await assert.rejects(
        db.query(
          "UPDATE transcript_workspace SET segmentation_version='chunks-v0' WHERE id=$1",
          [currentWorkspace],
        ),
        /transcript_workspace_contract_check/,
      );
      await db.query('ROLLBACK TO SAVEPOINT invalid_version');
      await db.query('SAVEPOINT missing_contract');
      await assert.rejects(
        db.query(
          'UPDATE transcript_workspace SET segmentation_version=NULL WHERE id=$1',
          [currentWorkspace],
        ),
        /not-null constraint/,
      );
      await db.query('ROLLBACK TO SAVEPOINT missing_contract');
      console.log(
        'ok: retires only the unused archived snapshot, preserves current data and requires the current contract',
      );
    } finally {
      await db.query('ROLLBACK');
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
