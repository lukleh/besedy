import { describe, expect, it } from 'vitest';
import { buildSourceFingerprint } from '@/lib/catalog-sync/source-snapshot';

describe('catalog sync source generations', () => {
  it('uses a versioned SHA-256 of the exact parsed bytes', () => {
    expect(buildSourceFingerprint('Hash\nabc\n')).toBe(
      'v3:sha256:8bed695e60381bf139dc1c4908e95b524c5c64fa795ba06bc045eca765857d52',
    );
  });

  it('changes when content changes even if its length does not', () => {
    expect(buildSourceFingerprint('Hash\na\n')).not.toBe(
      buildSourceFingerprint('Hash\nb\n'),
    );
  });
});
