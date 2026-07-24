import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import { canManageCatalogConfiguration } from "@/lib/policy/catalog";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { validateMutationSource, validateParams, notFound, handlePrismaError } from "@/lib/api";
import { logCatalogLifecycleEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id - Get a single workflow group (catalog)
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const access = await requireCatalogManagementAccess(id, {
      userId,
      activeCatalogOnly: false,
      auditResource: "catalog_settings",
      auditResourceId: id,
      deniedMessage: "Admin access required to view catalog settings",
      deniedReason: "Admin access required to view catalog settings",
      authorize: canManageCatalogConfiguration,
    });
    if (!access.ok) {
      return access.response;
    }

    const group = await prisma.workflowGroup.findUnique({
      where: { id },
      include: {
        variants: {
          orderBy: { variant: "asc" },
        },
      },
    });

    if (!group) {
      return notFound("catalog");
    }

    return NextResponse.json(group);
  } catch (error) {
    return handlePrismaError(error, "catalog", "fetch");
  }
}

/**
 * PUT /api/catalogs/:id - Update a workflow group (catalog)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const access = await requireCatalogManagementAccess(id, {
      userId: currentUserId,
      activeCatalogOnly: false,
      auditResource: "catalog_settings",
      auditResourceId: id,
      deniedMessage: "Admin access required to update catalog settings",
      deniedReason: "Admin access required to update catalog settings",
      authorize: canManageCatalogConfiguration,
    });
    if (!access.ok) {
      return access.response;
    }

    const body = await request.json();
    const {
      label,
      archivedCatalogPath,
      metadataCatalogPath,
      duplicatesCatalogPath,
      transcriptsPath,
      isDefault,
      isActive,
    } = body;

    // Check if group exists
    const existing = await prisma.workflowGroup.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFound("catalog");
    }

    // If setting as default, unset other defaults first
    if (isDefault === true) {
      await prisma.workflowGroup.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const group = await prisma.workflowGroup.update({
      where: { id },
      data: {
        ...(label !== undefined && { label }),
        ...(archivedCatalogPath !== undefined && { archivedCatalogPath }),
        ...(metadataCatalogPath !== undefined && { metadataCatalogPath }),
        ...(duplicatesCatalogPath !== undefined && { duplicatesCatalogPath }),
        ...(transcriptsPath !== undefined && { transcriptsPath }),
        ...(isDefault !== undefined && { isDefault }),
        ...(isActive !== undefined && { isActive }),
      },
      include: {
        variants: {
          orderBy: { variant: "asc" },
        },
      },
    });

    // Audit log catalog update (track what changed)
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (label !== undefined && label !== existing.label) {
      changes.label = { from: existing.label, to: label };
    }
    if (isActive !== undefined && isActive !== existing.isActive) {
      changes.isActive = { from: existing.isActive, to: isActive };
    }
    if (isDefault !== undefined && isDefault !== existing.isDefault) {
      changes.isDefault = { from: existing.isDefault, to: isDefault };
    }
    if (archivedCatalogPath !== undefined && archivedCatalogPath !== existing.archivedCatalogPath) {
      changes.archivedCatalogPath = { from: existing.archivedCatalogPath, to: archivedCatalogPath };
    }
    if (metadataCatalogPath !== undefined && metadataCatalogPath !== existing.metadataCatalogPath) {
      changes.metadataCatalogPath = { from: existing.metadataCatalogPath, to: metadataCatalogPath };
    }
    if (transcriptsPath !== undefined && transcriptsPath !== existing.transcriptsPath) {
      changes.transcriptsPath = { from: existing.transcriptsPath, to: transcriptsPath };
    }

    if (Object.keys(changes).length > 0) {
      await logCatalogLifecycleEvent({
        actorId: access.userId,
        action: "CATALOG_UPDATED",
        catalogId: id,
        catalogLabel: group.label,
        details: { changes },
      });
    }

    return NextResponse.json(group);
  } catch (error) {
    return handlePrismaError(error, "catalog", "update");
  }
}

/**
 * DELETE /api/catalogs/:id - Soft-delete a workflow group (sets isActive = false)
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(_request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const access = await requireCatalogManagementAccess(id, {
      userId: currentUserId,
      activeCatalogOnly: false,
      auditResource: "catalog_settings",
      auditResourceId: id,
      deniedMessage: "Admin access required to update catalog settings",
      deniedReason: "Admin access required to update catalog settings",
      authorize: canManageCatalogConfiguration,
    });
    if (!access.ok) {
      return access.response;
    }

    // Check if group exists
    const existing = await prisma.workflowGroup.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFound("catalog");
    }

    // Soft delete by setting isActive = false
    const group = await prisma.workflowGroup.update({
      where: { id },
      data: {
        isActive: false,
        isDefault: false, // Can't be default if inactive
      },
    });

    // If this was the active group in preferences, clear it
    await prisma.userPreferences.updateMany({
      where: { activeGroupId: id },
      data: { activeGroupId: null },
    });

    // Audit log catalog deactivation
    await logCatalogLifecycleEvent({
      actorId: access.userId,
      action: "CATALOG_DEACTIVATED",
      catalogId: id,
      catalogLabel: existing.label,
      details: {
        label: existing.label,
        wasDefault: existing.isDefault,
      },
    });

    return NextResponse.json({ success: true, group });
  } catch (error) {
    return handlePrismaError(error, "catalog", "delete");
  }
}
