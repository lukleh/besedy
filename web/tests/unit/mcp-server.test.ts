import { describe, expect, it } from 'vitest';
import { paginateCatalogs } from '@/lib/mcp/server';

describe('MCP server catalog pagination', () => {
  const catalogs = Array.from({ length: 105 }, (_, index) => ({
    id: `catalog-${String(index).padStart(3, '0')}`,
  }));

  it('returns stable bounded pages', () => {
    const first = paginateCatalogs(catalogs, undefined, 100);
    expect(first?.items).toHaveLength(100);
    expect(first?.nextCursor).toBe('catalog-099');

    const second = paginateCatalogs(
      catalogs,
      first?.nextCursor ?? undefined,
      100,
    );
    expect(second?.items).toEqual(catalogs.slice(100));
    expect(second?.nextCursor).toBeNull();
  });

  it('rejects an unknown cursor and clamps oversized internal calls', () => {
    expect(paginateCatalogs(catalogs, 'missing', 50)).toBeNull();
    expect(paginateCatalogs(catalogs, undefined, 1_000)?.items).toHaveLength(
      100,
    );
  });
});
