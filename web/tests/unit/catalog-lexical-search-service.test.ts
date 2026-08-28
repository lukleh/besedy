import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findAudioMetadata: vi.fn(),
  buildEligibleAudioHashesQuery: vi.fn(),
  lookupColbertNeighbors: vi.fn(),
  queryLexicalService: vi.fn(),
  resolveColbertIndexDir: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    $queryRaw: mocks.queryRaw,
    audioMetadata: { findMany: mocks.findAudioMetadata },
  },
}));

vi.mock(
  '@/app/api/catalogs/[id]/search/search-route-helpers',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/app/api/catalogs/[id]/search/search-route-helpers')
    >()),
    buildEligibleAudioHashesQuery: mocks.buildEligibleAudioHashesQuery,
    lookupColbertNeighbors: mocks.lookupColbertNeighbors,
    queryLexicalService: mocks.queryLexicalService,
    resolveColbertIndexDir: mocks.resolveColbertIndexDir,
  }),
);

import { executeCatalogLexicalSearch } from '@/app/api/catalogs/[id]/search/search-service';
import { getSearchConfig } from '@/app/api/catalogs/[id]/search/search-route-helpers';

describe('catalog lexical search service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveColbertIndexDir.mockResolvedValue('/bundle/colbert_index');
    mocks.buildEligibleAudioHashesQuery.mockReturnValue({ query: 'eligible' });
    mocks.queryRaw.mockResolvedValue([
      { audioHash: 'a'.repeat(64) },
      { audioHash: 'b'.repeat(64) },
    ]);
    mocks.queryLexicalService.mockResolvedValue({
      totalMatches: 8,
      matches: [
        {
          chunkId: 'chunk-1',
          audioHash: 'a'.repeat(64),
          startSec: 5,
          endSec: 10,
          text: 'literal evidence',
          runId: 'run-1',
          chunkVersion: 'v2',
          score: -1.25,
        },
      ],
    });
    mocks.findAudioMetadata.mockResolvedValue([]);
    mocks.lookupColbertNeighbors.mockResolvedValue(new Map());
  });

  it('filters the complete authorized recording set before FTS retrieval', async () => {
    const config = getSearchConfig();
    const filters = { eventIds: [42], verified: true };

    const result = await executeCatalogLexicalSearch({
      catalogId: 'catalog-a',
      query: 'literal evidence',
      matchMode: 'phrase',
      limit: 50,
      maxPerAudio: 10,
      metadataFilters: filters,
      accessLevel: 'VIEWER',
      config,
    });

    expect(mocks.buildEligibleAudioHashesQuery).toHaveBeenCalledWith(
      'catalog-a',
      'VIEWER',
      filters,
    );
    expect(mocks.queryRaw).toHaveBeenCalledWith({ query: 'eligible' });
    expect(mocks.queryLexicalService).toHaveBeenCalledWith(
      'literal evidence',
      'phrase',
      config.colbertUrl,
      '/bundle/colbert_index',
      ['a'.repeat(64), 'b'.repeat(64)],
      50,
      10,
      config.timeoutMs,
    );
    expect(result.totalMatches).toBe(8);
    expect(result.results).toMatchObject([
      {
        rank: 1,
        chunkId: 'chunk-1',
        citation: { workflowGroupId: 'catalog-a' },
      },
    ]);
  });
});
