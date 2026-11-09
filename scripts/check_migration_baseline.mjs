import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// A single reviewed history cutover; ordinary migration deletion stays forbidden.
const base = process.argv[2];
const manifestPath = 'web/prisma/baseline.json';
const migrationRoot = 'web/prisma/migrations';
try {
  const previous = execFileSync('git', ['ls-tree', '--name-only', base, manifestPath], { encoding: 'utf8' });
  if (previous.trim()) throw new Error('The baseline already exists on the base branch');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.baseline !== '20261108000000_current_schema') throw new Error('Unexpected baseline identity');
  const baseNames = execFileSync('git', ['ls-tree', '-d', '--name-only', base, `${migrationRoot}/`], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map(name => name.split('/').at(-1)).sort();
  if (JSON.stringify(baseNames) !== JSON.stringify(Object.keys(manifest.retired_migrations).sort())) {
    throw new Error('The reviewed baseline must replace the complete base migration history');
  }
  const removed = execFileSync('git', ['diff', '--name-only', '--diff-filter=D', base, '--', migrationRoot], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const expected = Object.keys(manifest.retired_migrations).map(name => `${migrationRoot}/${name}/migration.sql`).sort();
  if (JSON.stringify(removed.sort()) !== JSON.stringify(expected)) throw new Error('Retired migration set differs from the reviewed manifest');
  for (const [name, checksum] of Object.entries(manifest.retired_migrations)) {
    const content = execFileSync('git', ['show', `${base}:${migrationRoot}/${name}/migration.sql`]);
    if (createHash('sha256').update(content).digest('hex') !== checksum) throw new Error(`Migration changed on the base branch: ${name}`);
  }
  const sql = readFileSync(`${migrationRoot}/${manifest.baseline}/migration.sql`);
  if (createHash('sha256').update(sql).digest('hex') !== manifest.baseline_checksum) throw new Error('Baseline checksum differs from the reviewed manifest');
  console.log(`Verified current-schema baseline replacing ${expected.length} migrations`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
