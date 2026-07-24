import { syncActiveCatalogs } from '@/lib/catalog-sync';

const globalForCatalogSyncStartup = globalThis as unknown as {
  catalogSyncStartupPromise: Promise<void> | null;
  catalogSyncStartupState: CatalogStartupSyncState | undefined;
};

export interface CatalogStartupSyncState {
  status: 'not-started' | 'disabled' | 'running' | 'ready' | 'degraded';
  startedAt?: string;
  completedAt?: string;
  errors: number;
}

export interface CatalogStartupSyncConfig {
  enabled: boolean;
  requiredForReadiness: boolean;
}

export function getCatalogStartupSyncState(): CatalogStartupSyncState {
  return (
    globalForCatalogSyncStartup.catalogSyncStartupState ?? {
      status: 'not-started',
      errors: 0,
    }
  );
}

function isTestEnv(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  return process.env.APP_ENV === 'test';
}

function parseBooleanEnv(
  name: string,
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(
    `${name} must be one of true, false, 1, or 0; received ${JSON.stringify(raw)}`,
  );
}

export function getCatalogStartupSyncConfig(): CatalogStartupSyncConfig {
  const enabled = parseBooleanEnv(
    'CATALOG_SYNC_STARTUP_ENABLED',
    process.env.CATALOG_SYNC_STARTUP_ENABLED,
    !isTestEnv(),
  );
  const requiredForReadiness = parseBooleanEnv(
    'CATALOG_SYNC_REQUIRED_FOR_READINESS',
    process.env.CATALOG_SYNC_REQUIRED_FOR_READINESS,
    false,
  );

  if (!enabled && requiredForReadiness) {
    throw new Error(
      'CATALOG_SYNC_REQUIRED_FOR_READINESS cannot be enabled when CATALOG_SYNC_STARTUP_ENABLED is disabled',
    );
  }

  return { enabled, requiredForReadiness };
}

function buildTotals(
  results: Array<{ status: 'success' | 'skipped' | 'error' }>,
) {
  return {
    all: results.length,
    success: results.filter((result) => result.status === 'success').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    error: results.filter((result) => result.status === 'error').length,
  };
}

export async function triggerCatalogStartupSync(): Promise<void> {
  if (!getCatalogStartupSyncConfig().enabled) {
    globalForCatalogSyncStartup.catalogSyncStartupState = {
      status: 'disabled',
      errors: 0,
    };
    return;
  }
  if (globalForCatalogSyncStartup.catalogSyncStartupPromise) {
    await globalForCatalogSyncStartup.catalogSyncStartupPromise;
    return;
  }

  globalForCatalogSyncStartup.catalogSyncStartupPromise = (async () => {
    const startedAt = new Date();
    globalForCatalogSyncStartup.catalogSyncStartupState = {
      status: 'running',
      startedAt: startedAt.toISOString(),
      errors: 0,
    };
    console.info(
      `[catalog-sync] Startup sync started at ${startedAt.toISOString()}`,
    );

    try {
      const results = await syncActiveCatalogs();
      const totals = buildTotals(results);
      globalForCatalogSyncStartup.catalogSyncStartupState = {
        status: totals.error > 0 ? 'degraded' : 'ready',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        errors: totals.error,
      };
      console.info(
        `[catalog-sync] Startup sync finished at ${new Date().toISOString()} totals=${JSON.stringify(totals)}`,
      );

      for (const result of results) {
        if (result.status === 'error') {
          console.error(
            `[catalog-sync] ${result.groupId} error: ${result.error ?? 'Unknown error'}`,
          );
        }
      }
    } catch (error) {
      globalForCatalogSyncStartup.catalogSyncStartupState = {
        status: 'degraded',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        errors: 1,
      };
      console.error('[catalog-sync] Startup sync failed:', error);
    }
  })();

  await globalForCatalogSyncStartup.catalogSyncStartupPromise;
}
