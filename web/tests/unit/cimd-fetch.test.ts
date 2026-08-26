import { describe, expect, it } from 'vitest';
import { pinnedLookupResult } from '@/lib/auth/cimd-fetch';

describe('CIMD metadata transport', () => {
  const pinnedAddress = { address: '203.0.113.10', family: 4 };

  it('returns an address array when Node requests all lookup results', () => {
    expect(
      pinnedLookupResult(pinnedAddress, { all: true, verbatim: true }),
    ).toEqual([pinnedAddress]);
  });

  it('returns one address for a single-result lookup', () => {
    expect(
      pinnedLookupResult(pinnedAddress, { all: false, verbatim: true }),
    ).toEqual(pinnedAddress);
  });
});
