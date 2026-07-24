import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/health/route';
import {
  getCatalogStartupSyncConfig,
  getCatalogStartupSyncState,
} from '@/lib/catalog-sync-startup';

const { mockQueryRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: { $queryRaw: mockQueryRaw },
}));

vi.mock('@/lib/catalog-sync-startup', () => ({
  getCatalogStartupSyncConfig: vi.fn(),
  getCatalogStartupSyncState: vi.fn(),
}));

describe('health route catalog projection state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS;
    mockQueryRaw.mockResolvedValue([{ ok: 1 }]);
    vi.mocked(getCatalogStartupSyncConfig).mockReturnValue({
      enabled: true,
      requiredForReadiness: false,
    });
  });

  afterEach(() => {
    delete process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS;
  });

  it('surfaces a degraded projection while preserving availability by default', async () => {
    vi.mocked(getCatalogStartupSyncState).mockReturnValue({
      status: 'degraded',
      errors: 2,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      database: 'ok',
      catalogProjection: { status: 'degraded', errors: 2 },
    });
  });

  it('can require a current projection for readiness', async () => {
    vi.mocked(getCatalogStartupSyncConfig).mockReturnValue({
      enabled: true,
      requiredForReadiness: true,
    });
    vi.mocked(getCatalogStartupSyncState).mockReturnValue({
      status: 'degraded',
      errors: 1,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'error' });
  });

  it.each(['not-started', 'disabled', 'running'] as const)(
    'rejects the %s projection state when current readiness is required',
    async (status) => {
      vi.mocked(getCatalogStartupSyncConfig).mockReturnValue({
        enabled: true,
        requiredForReadiness: true,
      });
      vi.mocked(getCatalogStartupSyncState).mockReturnValue({
        status,
        errors: 0,
      });

      const response = await GET();

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'error',
        catalogProjection: { status },
      });
    },
  );

  it('accepts the ready projection state when current readiness is required', async () => {
    vi.mocked(getCatalogStartupSyncConfig).mockReturnValue({
      enabled: true,
      requiredForReadiness: true,
    });
    vi.mocked(getCatalogStartupSyncState).mockReturnValue({
      status: 'ready',
      errors: 0,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });
});
