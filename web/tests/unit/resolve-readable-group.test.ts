import { describe, expect, it } from 'vitest';
import { selectDefaultReadableGroup } from '@/lib/catalog/resolve-readable-group';

const groups = [
  { id: 'catalog-b', isDefault: false },
  { id: 'catalog-a', isDefault: true },
];

describe('selectDefaultReadableGroup', () => {
  it('prefers the saved accessible catalog', () => {
    expect(selectDefaultReadableGroup(groups, 'catalog-b')).toEqual({
      source: 'preference',
      group: groups[0],
    });
  });

  it('falls back to the global default and then the most recent catalog', () => {
    expect(selectDefaultReadableGroup(groups, 'catalog-stale')).toEqual({
      source: 'default',
      group: groups[1],
    });

    const groupsWithoutDefault = groups.map((group) => ({
      ...group,
      isDefault: false,
    }));
    expect(
      selectDefaultReadableGroup(groupsWithoutDefault, 'catalog-stale'),
    ).toEqual({
      source: 'recent',
      group: groupsWithoutDefault[0],
    });
  });

  it('returns null when no catalog is accessible', () => {
    expect(selectDefaultReadableGroup([], 'catalog-stale')).toBeNull();
  });
});
