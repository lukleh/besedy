import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, getCurrentUserId } from "@/lib/auth/permissions";
import { getCatalogDiscoveryCapability } from "@/lib/access/capabilities";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { CreateFullCatalogSchema } from "@/lib/validation/schemas";
import { validateMutationSource, validateRequestBody, handlePrismaError } from "@/lib/api";
import { logCatalogLifecycleEvent } from "@/lib/audit/logger";
import { syncCatalogGroup, type CatalogSyncResult } from "@/lib/catalog-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/catalogs - List active workflow groups (catalogs) accessible to the user
 *
 * Naming note: this plural endpoint returns workflow-group records. Use the
 * singular `/api/catalog` endpoint for paginated recording-entry browsing
 * inside one resolved catalog.
 *
 * Returns only catalogs the current user has access to.
 * Admins and superadmins see all active catalogs.
 */
export async function GET() {
  try {
    const userId = await requireAuth();

    const discovery = await getCatalogDiscoveryCapability(userId);

    // If user has no access to any catalogs, return empty array
    if (discovery.accessibleCatalogIds.length === 0) {
      return NextResponse.json([]);
    }

    const groups = await prisma.workflowGroup.findMany({
      where: {
        id: { in: discovery.accessibleCatalogIds },
        isActive: true,
      },
      orderBy: { id: "desc" },
      include: {
        variants: {
          orderBy: { variant: "asc" },
        },
      },
    });

    return NextResponse.json(groups);
  } catch (error) {
    return handlePrismaError(error, "catalogs", "fetch");
  }
}

/**
 * POST /api/catalogs - Create a new workflow group (catalog)
 * Requires: superadmin or canManageCatalogs capability
 *
 * The new group's CSVs are projected into the database right away, the same
 * sync the "Sync Catalog" action runs, so its recordings appear without waiting
 * for a restart. The group is created even when that sync fails; the result is
 * returned as `catalogSync` and the action can be retried from the settings.
 */
export async function POST(request: NextRequest) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    await requireAdminCapability({
      message: "Permission denied. Requires catalog management access.",
    });

    const bodyResult = await validateRequestBody(request, CreateFullCatalogSchema);
    if (!bodyResult.success) return bodyResult.response;
    const {
      id,
      label,
      archivedCatalogPath,
      metadataCatalogPath,
      transcriptsPath,
      isDefault,
    } = bodyResult.data;

    // If setting as default, unset other defaults first
    if (isDefault) {
      await prisma.workflowGroup.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const group = await prisma.workflowGroup.create({
      data: {
        id,
        label,
        archivedCatalogPath,
        metadataCatalogPath,
        transcriptsPath,
        isDefault: isDefault ?? false,
      },
    });

    // Audit log catalog creation
    await logCatalogLifecycleEvent({
      actorId: (await getCurrentUserId())!,
      action: "CATALOG_CREATED",
      catalogId: group.id,
      catalogLabel: group.label,
      details: {
        label: group.label,
        isDefault: group.isDefault,
      },
    });

    const catalogSync = await syncNewCatalog(group.id);

    return NextResponse.json({ ...group, catalogSync }, { status: 201 });
  } catch (error) {
    return handlePrismaError(error, "catalog", "create");
  }
}

async function syncNewCatalog(groupId: string): Promise<CatalogSyncResult> {
  let result: CatalogSyncResult;
  try {
    result = await syncCatalogGroup(groupId);
  } catch (error) {
    result = {
      groupId,
      status: "error",
      changedSources: [],
      rowCounts: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.status === "error") {
    console.error(`[catalog-sync] Initial sync failed for new catalog ${groupId}: ${result.error}`);
  }
  return result;
}
