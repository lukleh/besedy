import { describe, expect, it } from 'vitest';
import { verifyBaselineHistory } from '../../scripts/adopt-database-baseline';

const manifest = {
  baseline: 'current', baseline_checksum: 'current-checksum', schema_fingerprint: 'shape',
  retired_migrations: { first: 'one', second: 'two' }, production_checksums: { second: '' },
};
const row = (migration_name: string, checksum: string) => ({
  migration_name, checksum, finished_at: new Date(), rolled_back_at: null,
});

describe('current database baseline adoption', () => {
  it('requires every retired migration, allowing only the observed empty historical marker', () => {
    expect(verifyBaselineHistory([row('first', 'one'), row('second', '')], manifest)).toBe(true);
    expect(() => verifyBaselineHistory([row('first', 'one')], manifest)).toThrow('Missing or changed');
    expect(() => verifyBaselineHistory([row('first', 'wrong'), row('second', 'two')], manifest)).toThrow('Missing or changed');
  });

  it('refuses unfinished or later migrations before adoption', () => {
    expect(() => verifyBaselineHistory([{ ...row('first', 'one'), finished_at: null }], manifest)).toThrow('unfinished');
    expect(() => verifyBaselineHistory([row('first', 'one'), row('second', 'two'), row('later', 'three')], manifest)).toThrow('before later migrations');
  });

  it('rejects duplicate successful records instead of hiding their checksums', () => {
    expect(() => verifyBaselineHistory([
      row('first', 'wrong'), row('first', 'one'), row('second', 'two'),
    ], manifest)).toThrow('Duplicate completed');
  });

  it('is idempotent after adoption and still checks the baseline checksum', () => {
    expect(verifyBaselineHistory([row('current', 'current-checksum'), row('later', 'three')], manifest)).toBe(false);
    expect(() => verifyBaselineHistory([row('current', 'changed')], manifest)).toThrow('checksum differs');
  });
});
