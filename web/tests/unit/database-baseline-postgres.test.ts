import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { verifyBaselineFingerprint } from '../../scripts/adopt-database-baseline';

// Explicit throwaway database only: these tests roll back catalog mutations.
const connectionString = process.env.BASELINE_TEST_DATABASE_URL;
const sql = readFileSync(resolve('prisma/baseline-fingerprint.sql'), 'utf8');

describe.skipIf(!connectionString)('database baseline structural guards', () => {
  const client = new Client({ connectionString });
  beforeAll(async () => {
    const database = decodeURIComponent(new URL(connectionString!).pathname.slice(1));
    if (!/^(baseline(?:_|$)|besedy_(?:test|correction_ci)$)/.test(database)) {
      throw new Error('Baseline catalog mutation tests require an explicitly disposable database name');
    }
    await client.connect();
  });
  afterAll(async () => { await client.end(); });

  async function fingerprint() {
    return (await client.query<{ fingerprint: string }>(sql)).rows[0].fingerprint;
  }

  it('detects a disabled consent revocation trigger', async () => {
    const original = await fingerprint();
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE public."oauthConsent" DISABLE TRIGGER oauth_consent_revoke_refresh_tokens');
      expect(await fingerprint()).not.toBe(original);
    } finally { await client.query('ROLLBACK'); }
    expect(await fingerprint()).toBe(original);
  });

  it('rejects disabled internal foreign-key triggers using stable constraint identities', async () => {
    const original = await fingerprint();
    const manifest = { schema_fingerprint: original };
    expect(() => verifyBaselineFingerprint(original, manifest)).not.toThrow();
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE public.audio_metadata DISABLE TRIGGER ALL');
      // With RI triggers disabled this otherwise-invalid reference is accepted.
      await client.query(`INSERT INTO audio_metadata(workflow_group_id,audio_hash,updated_at)
        VALUES ('missing-group',repeat('a',64),now())`);
      const disabled = await fingerprint();
      expect(disabled).not.toBe(original);
      expect(() => verifyBaselineFingerprint(disabled, manifest)).toThrow('Database structure differs');
    } finally { await client.query('ROLLBACK'); }
    expect(await fingerprint()).toBe(original);
  });

  it.each(['indisvalid', 'indisready', 'indislive'])('detects a partial unique index with %s disabled', async column => {
    const original = await fingerprint();
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE pg_catalog.pg_index SET ${column} = false
        WHERE indexrelid = 'public.transcript_workspace_live_per_recording_key'::regclass`);
      expect(await fingerprint()).not.toBe(original);
    } finally { await client.query('ROLLBACK'); }
    expect(await fingerprint()).toBe(original);
  });
});
