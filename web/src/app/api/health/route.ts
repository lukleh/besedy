import prisma from '@/lib/db';
import {
  getCatalogStartupSyncConfig,
  getCatalogStartupSyncState,
} from '@/lib/catalog-sync-startup';

export const dynamic = 'force-dynamic';

/**
 * Health check endpoint for container readiness probes.
 * Returns 200 OK if the server and database are healthy.
 * Returns 503 if the database is unreachable.
 */
export async function GET() {
  try {
    // Verify database connectivity with a simple query
    await prisma.$queryRaw`SELECT 1`;

    const catalogProjection = getCatalogStartupSyncState();
    const { requiredForReadiness } = getCatalogStartupSyncConfig();
    const projectionIsDegraded = catalogProjection.status === 'degraded';
    const unavailable =
      requiredForReadiness && catalogProjection.status !== 'ready';

    return Response.json(
      {
        status: unavailable
          ? 'error'
          : projectionIsDegraded
            ? 'degraded'
            : 'ok',
        database: 'ok',
        catalogProjection,
      },
      { status: unavailable ? 503 : 200 },
    );
  } catch (error) {
    console.error('Health check failed:', error);
    return Response.json({ status: 'error' }, { status: 503 });
  }
}
