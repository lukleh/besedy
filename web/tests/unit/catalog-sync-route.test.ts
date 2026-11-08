import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '@/lib/auth/permissions';
import { GET, POST } from '@/app/api/admin/catalog-sync/route';
import { fetchJson } from '@/lib/api/fetch-json';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  group: vi.fn(),
  states: vi.fn(),
  sync: vi.fn(),
  syncAll: vi.fn(),
}));
vi.mock('@/lib/access/require-admin', () => ({
  requireAdminCapability: mocks.requireAdmin,
}));
vi.mock('@/lib/db', () => ({
  default: {
    workflowGroup: { findUnique: mocks.group },
    catalogSyncState: { findMany: mocks.states },
  },
}));
vi.mock('@/lib/catalog-sync', () => ({
  syncCatalogGroup: mocks.sync,
  syncActiveCatalogs: mocks.syncAll,
}));

const groupId = '20251222_144441';
const request = (query = `groupId=${groupId}`) =>
  new NextRequest(`http://localhost/api/admin/catalog-sync?${query}`);

describe('catalog sync operator routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BESEDY_ARCHIVE_ID', groupId);
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    mocks.group.mockResolvedValue({ id: groupId, isActive: true });
    mocks.states.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([401, 403])(
    'refuses status and mutation requests without system-admin authorization (%i)',
    async (status) => {
      mocks.requireAdmin.mockRejectedValue(
        new AuthError('Unauthorized', status),
      );
      expect((await GET(request())).status).toBe(status);
      expect(
        (
          await POST(
            new NextRequest('http://localhost/api/admin/catalog-sync', {
              method: 'POST',
              headers: {
                origin: 'http://localhost',
                'content-type': 'application/json',
              },
              body: '{}',
            }),
          )
        ).status,
      ).toBe(status);
      expect(mocks.group).not.toHaveBeenCalled();
      expect(mocks.states).not.toHaveBeenCalled();
      expect(mocks.syncAll).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'groupId=bad', 'groupId=../../other'])(
    'requires one validated catalog identifier (%s)',
    async (query) => {
      expect((await GET(request(query))).status).toBe(400);
      expect(mocks.group).not.toHaveBeenCalled();
      expect(mocks.states).not.toHaveBeenCalled();
    },
  );

  it('returns 503 when the configured source is missing without reading projection status', async () => {
    mocks.group.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(503);
    expect(mocks.states).not.toHaveBeenCalled();
  });

  it('reads bounded source snapshots without selecting paths or fingerprints', async () => {
    const source = {
      sourceKey: 'metadata',
      status: 'ERROR',
      syncedAt: new Date('2026-11-06T10:00:00Z'),
      lastSuccessfulAt: new Date('2026-11-05T10:00:00Z'),
      lastError: 'Invalid metadata catalog CSV: MissingQuotes',
      rowCount: 12,
    };
    mocks.states.mockResolvedValue([source]);
    const response = await GET(request());
    expect(await response.json()).toEqual({
      groupId,
      sources: [
        {
          ...source,
          syncedAt: source.syncedAt.toISOString(),
          lastSuccessfulAt: source.lastSuccessfulAt.toISOString(),
        },
      ],
    });
    expect(mocks.states).toHaveBeenCalledWith({
      where: {
        workflowGroupId: groupId,
        sourceKey: { in: ['metadata', 'archived', 'duplicates'] },
      },
      take: 3,
      orderBy: { sourceKey: 'asc' },
      select: {
        sourceKey: true,
        status: true,
        syncedAt: true,
        lastSuccessfulAt: true,
        lastError: true,
        rowCount: true,
      },
    });
  });

  it('returns the actual failed sync cause through the shared fetchJson error path', async () => {
    const cause =
      'Invalid metadata catalog CSV: data row 1 has a blank Full Path';
    mocks.sync.mockResolvedValue({
      groupId,
      status: 'error',
      changedSources: ['metadata'],
      rowCounts: {},
      error: cause,
    });
    const response = await POST(
      new NextRequest('http://localhost/api/admin/catalog-sync', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ groupId }),
      }),
    );
    expect(response.status).toBe(500);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchJson('/api/admin/catalog-sync')).rejects.toThrow(
      `${groupId}: ${cause}`,
    );
  });
});
