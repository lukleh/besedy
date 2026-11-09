import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

// This opt-in upgrade test needs the disposable database immediately before
// require_canonical_audit_records. Every DDL/data change rolls back per test.
const connectionString = process.env.BESEDY_AUDIT_MIGRATION_TEST_DATABASE_URL;
const migration = readFileSync(
  path.resolve(
    __dirname,
    '../../prisma/migrations/20261108225250_require_canonical_audit_records/migration.sql',
  ),
  'utf8',
)
  .replace(/^BEGIN;\s*/, '')
  .replace(/COMMIT;\s*$/, '');

function currentAudit() {
  return {
    payloadVersion: 1,
    domain: 'auth',
    subjectType: 'user',
    outcome: 'success',
    summary: 'User signed in',
    actorSnapshot: { type: 'anonymous' },
    subjectSnapshot: { type: 'user', id: null },
  };
}

const invalid = [
  ['missing envelope', {}],
  ['null envelope', { audit: null }],
  ['older version', { audit: { ...currentAudit(), payloadVersion: 0 } }],
  ['string version', { audit: { ...currentAudit(), payloadVersion: '1' } }],
  ['domain mismatch', { audit: { ...currentAudit(), domain: 'content' } }],
  ['subject mismatch', { audit: { ...currentAudit(), subjectType: 'audio' } }],
  ['outcome mismatch', { audit: { ...currentAudit(), outcome: 'denied' } }],
  ['empty summary', { audit: { ...currentAudit(), summary: '' } }],
  ['absent summary', { audit: { ...currentAudit(), summary: undefined } }],
  [
    'absent actor snapshot',
    { audit: { ...currentAudit(), actorSnapshot: undefined } },
  ],
  [
    'null subject snapshot',
    { audit: { ...currentAudit(), subjectSnapshot: null } },
  ],
] as const;

describe.skipIf(!connectionString)('PostgreSQL canonical audit cutover', () => {
  const db = new Client({ connectionString });
  beforeAll(async () => {
    if (
      !connectionString ||
      new URL(connectionString).pathname !== '/besedy_audit_migration_test'
    ) {
      throw new Error(
        'Audit migration verification requires the explicit disposable besedy_audit_migration_test database',
      );
    }
    await db.connect();
  });
  beforeEach(async () => {
    await db.query('BEGIN');
  });
  afterEach(async () => {
    await db.query('ROLLBACK');
  });
  afterAll(async () => {
    await db.end();
  });

  async function insert(details: unknown, domain: string | null = 'auth') {
    const id = randomUUID();
    await db.query(
      `INSERT INTO audit_log(id,action,domain,subject_type,outcome,payload_version,resource,details)
      VALUES ($1,'LOGIN',$2,'user','success',1,'user',$3::jsonb)`,
      [id, domain, JSON.stringify(details)],
    );
    return id;
  }

  it.each(invalid)(
    'refuses existing records with %s without rewriting history',
    async (_label, details) => {
      const id = await insert(details);
      await db.query('SAVEPOINT migration');
      await expect(db.query(migration)).rejects.toMatchObject({
        code: '23514',
      });
      await db.query('ROLLBACK TO SAVEPOINT migration');
      expect(
        (await db.query('SELECT details FROM audit_log WHERE id=$1', [id]))
          .rows[0].details,
      ).toEqual(JSON.parse(JSON.stringify(details)));
    },
  );

  it('refuses absent canonical columns', async () => {
    await insert({ audit: currentAudit() }, null);
    await expect(db.query(migration)).rejects.toMatchObject({ code: '23502' });
  });

  it('preserves valid history and enforces the same contract on future writes', async () => {
    const id = await insert({ audit: currentAudit(), operation: 'unchanged' });
    const before = (
      await db.query('SELECT to_jsonb(a) AS row FROM audit_log a WHERE id=$1', [
        id,
      ])
    ).rows[0].row;
    await db.query(migration);
    expect(
      (
        await db.query(
          'SELECT to_jsonb(a) AS row FROM audit_log a WHERE id=$1',
          [id],
        )
      ).rows[0].row,
    ).toEqual(before);
    for (const [label, details] of invalid) {
      await db.query('SAVEPOINT invalid_insert');
      await expect(insert(details), label).rejects.toMatchObject({
        code: '23514',
      });
      await db.query('ROLLBACK TO SAVEPOINT invalid_insert');
    }
    // Global events can legitimately have no user, subject ID or catalog ID.
    await expect(insert({ audit: currentAudit() })).resolves.toBeTypeOf(
      'string',
    );
  });
});
