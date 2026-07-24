import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCatalogStartupSyncConfig } from '@/lib/catalog-sync-startup';

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.CATALOG_SYNC_STARTUP_ENABLED;
  delete process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS;
});

describe('catalog startup sync configuration', () => {
  it('rejects required readiness when startup sync is disabled', () => {
    process.env.CATALOG_SYNC_STARTUP_ENABLED = 'false';
    process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS = 'true';

    expect(() => getCatalogStartupSyncConfig()).toThrow(
      'CATALOG_SYNC_REQUIRED_FOR_READINESS cannot be enabled',
    );
  });

  it('rejects malformed boolean values', () => {
    process.env.CATALOG_SYNC_STARTUP_ENABLED = 'yes';

    expect(() => getCatalogStartupSyncConfig()).toThrow(
      'CATALOG_SYNC_STARTUP_ENABLED must be one of true, false, 1, or 0',
    );
  });

  it('treats empty Compose values as unset', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.CATALOG_SYNC_STARTUP_ENABLED = '';
    process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS = '';

    expect(getCatalogStartupSyncConfig()).toEqual({
      enabled: true,
      requiredForReadiness: false,
    });
  });

  it('uses production-safe defaults outside test environments', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'production');

    expect(getCatalogStartupSyncConfig()).toEqual({
      enabled: true,
      requiredForReadiness: false,
    });
  });
});
