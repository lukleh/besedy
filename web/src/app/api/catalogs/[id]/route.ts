import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import { hasSystemAdminAuthority } from "@/lib/policy/actor";
import { canManageCatalogConfiguration } from "@/lib/policy/catalog";
import { TimestampIdParamSchema, UpdateCatalogSchema } from "@/lib/validation/schemas";
import {
  validateMutationSource,
  validateParams,
  validateRequestBody,
  forbidden,
  notFound,
  handlePrismaError,
} from "@/lib/api";
import { logAccessDenied, logCatalogLifecycleEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UPDATABLE_CATALOG_FIELDS = [
  "label",
  "archivedCatalogPath",
  "metadataCatalogPath",
  "duplicatesCatalogPath",
  "transcriptsPath",
  "isDefault",
  "isActive",
] as const;

/** Fields a catalog administrator may not change; see ADR 0005. */
const SYSTEM_ONLY_CATALOG_FIELDS = [
  "archivedCatalogPath",
  "metadataCatalogPath",
  "duplicatesCatalogPath",
  "transcriptsPath",
  "isDefault",
  "isActive",
] as const;

const SYSTEM_ONLY_DENIED_MESSAGE =
  "System admin access required to change catalog paths, default or active flags";

const DEACTIVATE_DENIED_MESSAGE = "System admin access required to deactivate a catalog";

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

    const bodyResult = await validateRequestBody(request, UpdateCatalogSchema);
    if (!bodyResult.success) return bodyResult.response;
    const updates = bodyResult.data;

    // Check if group exists
    const existing = await prisma.workflowGroup.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFound("catalog");
    }

    // The settings form sends every field, so compare with the stored row and
    // authorize, write and record only what actually changes.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const data: Partial<
      Pick<typeof existing, (typeof UPDATABLE_CATALOG_FIELDS)[number]>
    > = {};
    for (const field of UPDATABLE_CATALOG_FIELDS) {
      const to = updates[field];
      if (to !== undefined && to !== existing[field]) {
        changes[field] = { from: existing[field], to };
        Object.assign(data, { [field]: to });
      }
    }

    // Paths decide which files a catalog reads and serves, and the default and
    // active flags reach every user of the portal, so a catalog grant does not
    // cover them: they need the same system authority as creating a catalog.
    const systemOnlyChanges = SYSTEM_ONLY_CATALOG_FIELDS.filter(
      (field) => field in changes
    );
    if (systemOnlyChanges.length > 0 && !hasSystemAdminAuthority(access.actor)) {
      await logAccessDenied(access.userId, "catalog_settings", id, {
        catalogId: id,
        reason: SYSTEM_ONLY_DENIED_MESSAGE,
        fields: systemOnlyChanges,
      });
      return forbidden(SYSTEM_ONLY_DENIED_MESSAGE);
    }

    const group = await prisma.$transaction(async (tx) => {
      // If setting as default, unset other defaults in the same transaction so
      // a failed update cannot leave the portal without a default catalog.
      if (data.isDefault === true) {
        await tx.workflowGroup.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      return tx.workflowGroup.update({
        where: { id },
        data,
      });
    });

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

    // Deactivating clears the active and default flags, which PUT reserves for
    // system admins, so a catalog grant does not cover it either (ADR 0005).
    if (!hasSystemAdminAuthority(access.actor)) {
      await logAccessDenied(access.userId, "catalog_settings", id, {
        catalogId: id,
        reason: DEACTIVATE_DENIED_MESSAGE,
        fields: ["isActive", "isDefault"],
      });
      return forbidden(DEACTIVATE_DENIED_MESSAGE);
    }

    const group = await prisma.$transaction(async (tx) => {
      // Soft delete by setting isActive = false
      const deactivated = await tx.workflowGroup.update({
        where: { id },
        data: {
          isActive: false,
          isDefault: false, // Can't be default if inactive
        },
      });

      // If this was the active group in preferences, clear it
      await tx.userPreferences.updateMany({
        where: { activeGroupId: id },
        data: { activeGroupId: null },
      });

      return deactivated;
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
