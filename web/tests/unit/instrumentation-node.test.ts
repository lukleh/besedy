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
import { register } from '@/instrumentation';

describe('node instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('BESEDY_ARCHIVE_ID', '20251225_120000');
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

  describe.each(['production', 'development'])(
    '%s server startup',
    (mode) => {
      it.each([undefined, '', '  ', 'newest', '20251225_120000/extra'])(
        'refuses invalid archive configuration %j before reconciliation',
        async (value) => {
          vi.stubEnv('NODE_ENV', mode);
          vi.stubEnv('BESEDY_ARCHIVE_ID', value);

          await expect(register()).rejects.toThrow('BESEDY_ARCHIVE_ID');

          expect(getCatalogStartupSyncConfig).not.toHaveBeenCalled();
          expect(triggerCatalogStartupSync).not.toHaveBeenCalled();
        },
      );
    },
  );

  it('validates a configured development server without starting reconciliation', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await expect(register()).resolves.toBeUndefined();

    expect(getCatalogStartupSyncConfig).not.toHaveBeenCalled();
    expect(triggerCatalogStartupSync).not.toHaveBeenCalled();
  });

  it('leaves non-Node runtimes outside Node startup validation', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('BESEDY_ARCHIVE_ID', undefined);

    await expect(register()).resolves.toBeUndefined();

    expect(getCatalogStartupSyncConfig).not.toHaveBeenCalled();
    expect(triggerCatalogStartupSync).not.toHaveBeenCalled();
  });

  it('still refuses invalid readiness configuration before reconciliation', async () => {
    getCatalogStartupSyncConfig.mockImplementation(() => {
      throw new Error('Invalid readiness configuration');
    });

    await expect(register()).rejects.toThrow('Invalid readiness configuration');

    expect(triggerCatalogStartupSync).not.toHaveBeenCalled();
  });
});
