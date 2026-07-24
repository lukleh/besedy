import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { triggerCatalogStartupSync, getCatalogStartupSyncConfig } = vi.hoisted(
  () => ({
    triggerCatalogStartupSync: vi.fn(),
    getCatalogStartupSyncConfig: vi.fn(),
  }),
);

vi.mock('@/lib/catalog-sync-startup', () => ({
  triggerCatalogStartupSync,
  getCatalogStartupSyncConfig,
}));

import { registerNodeInstrumentation } from '@/instrumentation.node';

describe('node instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    getCatalogStartupSyncConfig.mockReturnValue({
      enabled: true,
      requiredForReadiness: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts catalog reconciliation without awaiting its completion', async () => {
    triggerCatalogStartupSync.mockReturnValue(new Promise(() => undefined));

    await expect(registerNodeInstrumentation()).resolves.toBeUndefined();

    expect(getCatalogStartupSyncConfig).toHaveBeenCalledOnce();
    expect(triggerCatalogStartupSync).toHaveBeenCalledOnce();
  });
});
