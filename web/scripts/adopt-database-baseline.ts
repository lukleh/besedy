import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

interface Manifest {
  baseline: string;
  baseline_checksum: string;
  schema_fingerprint: string;
  retired_migrations: Record<string, string>;
  production_checksums: Record<string, string>;
}

interface AppliedMigration {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export function verifyBaselineHistory(rows: AppliedMigration[], manifest: Manifest): boolean {
  if (rows.some(row => !row.finished_at && !row.rolled_back_at)) {
    throw new Error('Resolve unfinished migrations before adopting the baseline');
  }
  const completed = rows.filter(row => row.finished_at && !row.rolled_back_at);
  const applied = new Map(completed.map(row => [row.migration_name, row.checksum]));
  if (applied.size !== completed.length) throw new Error('Duplicate completed migration records');
  if (applied.has(manifest.baseline)) {
    if (applied.get(manifest.baseline) !== manifest.baseline_checksum) throw new Error('Applied baseline checksum differs');
    return false;
  }
  for (const [name, checksum] of Object.entries(manifest.retired_migrations)) {
    const actual = applied.get(name);
    if (actual === undefined || (actual !== checksum && actual !== manifest.production_checksums[name])) {
      throw new Error(`Missing or changed migration: ${name}`);
    }
  }
  for (const name of applied.keys()) {
    if (!(name in manifest.retired_migrations)) throw new Error(`Adopt the baseline before later migrations: ${name}`);
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: adopt-database-baseline.ts [--apply]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must explicitly select the database');
  const manifest = JSON.parse(readFileSync(resolve('prisma/baseline.json'), 'utf8')) as Manifest;
  const baseline = readFileSync(resolve('prisma/migrations', manifest.baseline, 'migration.sql'));
  if (createHash('sha256').update(baseline).digest('hex') !== manifest.baseline_checksum) {
    throw new Error('Baseline file checksum differs from the reviewed manifest');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const { rows } = await client.query<AppliedMigration>('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations');
    if (!verifyBaselineHistory(rows, manifest)) {
      console.log('Current baseline is already recorded; no changes needed');
      return;
    }
    const fingerprintSql = readFileSync(resolve('prisma/baseline-fingerprint.sql'), 'utf8');
    const fingerprint = await client.query<{ fingerprint: string }>(fingerprintSql);
    if (fingerprint.rows[0]?.fingerprint !== manifest.schema_fingerprint) {
      throw new Error('Database structure differs from the reviewed baseline; investigate drift before adopting');
    }
    console.log(`Verified ${Object.keys(manifest.retired_migrations).length} migrations and the complete current schema`);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
  if (!args.includes('--apply')) {
    console.log('Read-only check complete. Stop writers and rerun with --apply during the deployment maintenance window.');
    return;
  }
  // Prisma records the baseline without running its DDL or changing prior history.
  const result = spawnSync(resolve('node_modules/.bin/prisma'), ['migrate', 'resolve', '--applied', manifest.baseline], {
    env: process.env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Baseline adoption exited with ${result.status}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/adopt-database-baseline.ts')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
