import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, getCurrentUserId } from "@/lib/auth/permissions";
import { getCatalogDiscoveryCapability } from "@/lib/access/capabilities";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { CreateFullCatalogSchema } from "@/lib/validation/schemas";
import { validateMutationSource, validateRequestBody, handlePrismaError } from "@/lib/api";
import { logCatalogLifecycleEvent } from "@/lib/audit/logger";

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

    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return handlePrismaError(error, "catalog", "create");
  }
}
