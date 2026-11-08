import { requireArchiveId } from '@/lib/archive-config';

export async function registerNodeInstrumentation(): Promise<void> {
  requireArchiveId();
  if (process.env.NODE_ENV === 'development') {
    return;
  }
  const { getCatalogStartupSyncConfig, triggerCatalogStartupSync } =
    await import('@/lib/catalog-sync-startup');
  // Reject invalid readiness configuration before startup completes, but let
  // reconciliation continue in the background so the health route can report
  // its running state instead of delaying server bootstrap.
  getCatalogStartupSyncConfig();
  void triggerCatalogStartupSync();
}
