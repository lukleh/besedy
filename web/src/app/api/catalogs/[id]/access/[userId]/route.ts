import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  canAttemptCatalogManagement,
  canGrantCatalogAccessLevel,
  canManageExistingCatalogAccessLevel,
} from "@/lib/policy/catalog";
import { CatalogUserParamSchema, UpdateAccessWithNameSchema, RestoreAccessSchema } from "@/lib/validation/schemas";
import { validateMutationSource, validateParams, validateRequestBody, forbidden, notFound, badRequest, handlePrismaError } from "@/lib/api";
import { logCatalogAccessEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; userId: string }>;
}

/**
 * PUT /api/catalogs/:id/access/:userId - Update user's access level and optionally their name
 * Body: { accessLevel: AccessLevel, notes?: string, userName?: string }
 * Admin can update to any level including OWNER
 * OWNER can update LISTENER/VIEWER/MEMBER/EDITOR but not OWNER
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, CatalogUserParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, userId: targetUserId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, UpdateAccessWithNameSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { accessLevel, notes, userName } = bodyResult.data;

    // Check permissions first to prevent information disclosure
    // (unauthorized users shouldn't learn whether a grant exists)
    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId: currentUserId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!managementAccess.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    // Check if access grant exists
    const existingAccess = await prisma.catalogAccess.findUnique({
      where: {
        userId_catalogId: { userId: targetUserId, catalogId },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (!existingAccess) {
      return notFound("access grant");
    }

    // Cannot update REVOKED access - use POST to restore
    if (existingAccess.status === "REVOKED") {
      return badRequest("Cannot update revoked access. Use POST to restore access.");
    }

    // Only admins can promote to OWNER
    if (!canGrantCatalogAccessLevel(managementAccess.policyContext, accessLevel)) {
      return forbidden("Only administrators can grant OWNER access");
    }

    if (!canManageExistingCatalogAccessLevel(managementAccess.policyContext, existingAccess.accessLevel)) {
      return forbidden("Only administrators can modify OWNER access");
    }

    // Prevent removing your own OWNER access (would lock yourself out)
    if (currentUserId === targetUserId && existingAccess.accessLevel === "OWNER" && accessLevel !== "OWNER") {
      return badRequest("Cannot demote yourself from OWNER. Ask another admin or owner to do this.");
    }

    const updatedAccess = await prisma.$transaction(async (tx) => {
      if (userName !== undefined) {
        await tx.user.update({
          where: { id: targetUserId },
          data: { name: userName },
        });
      }

      return tx.catalogAccess.update({
        where: {
          userId_catalogId: { userId: targetUserId, catalogId },
        },
        data: {
          accessLevel,
          notes: notes !== undefined ? notes || null : existingAccess.notes,
          grantedById: currentUserId, // Track who made the change
        },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          grantedBy: { select: { id: true, name: true, email: true } },
        },
      });
    });

    // Audit log access update
    await logCatalogAccessEvent({
      actorId: currentUserId,
      action: "CATALOG_ACCESS_UPDATED",
      accessResourceId: `${targetUserId}:${catalogId}`,
      targetUserId,
      targetEmail: existingAccess.user.email,
      catalogId,
      accessLevel,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        previousAccessLevel: existingAccess.accessLevel,
        newAccessLevel: accessLevel,
      },
    });

    return NextResponse.json(updatedAccess);
  } catch (error) {
    return handlePrismaError(error, "catalog access", "update");
  }
}

/**
 * PATCH /api/catalogs/:id/access/:userId - Restore revoked access
 * Body: { action: "restore" }
 * Restores REVOKED access to ACTIVE
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, CatalogUserParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, userId: targetUserId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, RestoreAccessSchema);
    if (!bodyResult.success) return bodyResult.response;

    // Check permissions
    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId: currentUserId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!managementAccess.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    // Check if access grant exists
    const existingAccess = await prisma.catalogAccess.findUnique({
      where: {
        userId_catalogId: { userId: targetUserId, catalogId },
      },
      include: {
        user: { select: { email: true } },
      },
    });

    if (!existingAccess) {
      return notFound("access grant");
    }

    if (existingAccess.status === "ACTIVE") {
      return badRequest("Access is already active");
    }

    // Only admins can restore OWNER access
    if (!canManageExistingCatalogAccessLevel(managementAccess.policyContext, existingAccess.accessLevel)) {
      return forbidden("Only administrators can restore OWNER access");
    }

    // Restore access
    const restoredAccess = await prisma.catalogAccess.update({
      where: {
        userId_catalogId: { userId: targetUserId, catalogId },
      },
      data: {
        status: "ACTIVE",
        revokedById: null,
        revokedAt: null,
        grantedById: currentUserId,
      },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
        grantedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Audit log access restored (use GRANTED since we're re-granting)
    await logCatalogAccessEvent({
      actorId: currentUserId,
      action: "CATALOG_ACCESS_GRANTED",
      accessResourceId: `${targetUserId}:${catalogId}`,
      targetUserId,
      targetEmail: existingAccess.user.email,
      catalogId,
      accessLevel: existingAccess.accessLevel,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        accessLevel: existingAccess.accessLevel,
        restored: true,
      },
    });

    return NextResponse.json(restoredAccess);
  } catch (error) {
    return handlePrismaError(error, "catalog access", "restore");
  }
}

/**
 * DELETE /api/catalogs/:id/access/:userId - Revoke user's access (soft-delete)
 * Admin can revoke any access
 * OWNER can revoke LISTENER/VIEWER/MEMBER/EDITOR but not OWNER
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(_request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, CatalogUserParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, userId: targetUserId } = paramsResult.data;

    // Check permissions first to prevent information disclosure
    // (unauthorized users shouldn't learn whether a grant exists)
    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId: currentUserId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!managementAccess.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    // Check if access grant exists
    const existingAccess = await prisma.catalogAccess.findUnique({
      where: {
        userId_catalogId: { userId: targetUserId, catalogId },
      },
      include: {
        user: { select: { email: true } },
      },
    });

    if (!existingAccess) {
      return notFound("access grant");
    }

    // Already revoked
    if (existingAccess.status === "REVOKED") {
      return badRequest("Access is already revoked");
    }

    // Only admins can revoke OWNER access
    if (!canManageExistingCatalogAccessLevel(managementAccess.policyContext, existingAccess.accessLevel)) {
      return forbidden("Only administrators can revoke OWNER access");
    }

    // Prevent revoking your own access
    if (currentUserId === targetUserId) {
      return badRequest("Cannot revoke your own access. Ask another admin or owner to do this.");
    }

    // Soft-delete: set status to REVOKED
    await prisma.catalogAccess.update({
      where: {
        userId_catalogId: { userId: targetUserId, catalogId },
      },
      data: {
        status: "REVOKED",
        revokedById: currentUserId,
        revokedAt: new Date(),
      },
    });

    // Audit log access revocation
    await logCatalogAccessEvent({
      actorId: currentUserId,
      action: "CATALOG_ACCESS_REVOKED",
      accessResourceId: `${targetUserId}:${catalogId}`,
      targetUserId,
      targetEmail: existingAccess.user.email,
      catalogId,
      accessLevel: existingAccess.accessLevel,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        accessLevel: existingAccess.accessLevel,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "catalog access", "revoke");
  }
}
