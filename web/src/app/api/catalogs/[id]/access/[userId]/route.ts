import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import {
  grantFieldsForRole,
  mergeGrantableExtraPermissions,
} from "@/lib/policy/catalog-permissions";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  canAttemptCatalogManagement,
  canGrantCatalogGrant,
  canManageExistingCatalogGrant,
  canRevokeExistingCatalogGrant,
  isSelfCatalogAccessChange,
} from "@/lib/policy/catalog";
import {
  CatalogUserParamSchema,
  UpdateAccessWithNameSchema,
  RestoreAccessSchema,
} from "@/lib/validation/schemas";
import {
  validateMutationSource,
  validateParams,
  validateRequestBody,
  forbidden,
  notFound,
  badRequest,
  handlePrismaError,
} from "@/lib/api";
import { logCatalogAccessEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; userId: string }>;
}

/**
 * PUT /api/catalogs/:id/access/:userId - Update a user's catalog grant.
 * Body: { role: CatalogRole, extraPermissions?: string[], notes?: string, userName?: string }
 * Catalog administrators may update any grant. Hosts may update only grants
 * whose old and new roles carry no protected permission and no extras.
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

    const bodyResult = await validateRequestBody(
      request,
      UpdateAccessWithNameSchema
    );
    if (!bodyResult.success) return bodyResult.response;
    const { role, extraPermissions, notes, userName } = bodyResult.data;

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
      return forbidden("Catalog access-management permission required");
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
      return badRequest(
        "Cannot update revoked access. Use POST to restore access."
      );
    }

    // Only administrators may hand out protected access, and the same test
    // applies to the access being replaced.
    if (
      !canGrantCatalogGrant(
        managementAccess.policyContext,
        role,
        extraPermissions
      )
    ) {
      return forbidden(
        "Only catalog administrators can grant this role or extras"
      );
    }

    if (
      !canManageExistingCatalogGrant(managementAccess.policyContext, {
        role: existingAccess.role,
        extras: existingAccess.extraPermissions,
      })
    ) {
      return forbidden("Only catalog administrators can modify this access");
    }

    if (isSelfCatalogAccessChange(currentUserId, targetUserId)) {
      return badRequest(
        "Cannot change your own access. Ask another admin or owner to do this."
      );
    }

    const storedExtraPermissions = mergeGrantableExtraPermissions(
      existingAccess.extraPermissions,
      extraPermissions
    );

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
          ...grantFieldsForRole(role, storedExtraPermissions),
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
      role: updatedAccess.role,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        previousRole: existingAccess.role,
        previousExtraPermissions: existingAccess.extraPermissions,
        newRole: role,
        newExtraPermissions: storedExtraPermissions,
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
      return forbidden("Catalog access-management permission required");
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

    // Only administrators may restore protected access.
    if (
      !canManageExistingCatalogGrant(managementAccess.policyContext, {
        role: existingAccess.role,
        extras: existingAccess.extraPermissions,
      })
    ) {
      return forbidden("Only catalog administrators can restore this access");
    }

    if (isSelfCatalogAccessChange(currentUserId, targetUserId)) {
      return badRequest(
        "Cannot change your own access. Ask another admin or owner to do this."
      );
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
      role: existingAccess.role,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        role: existingAccess.role,
        extraPermissions: existingAccess.extraPermissions,
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
 * Catalog administrators may revoke any grant.
 * Hosts may revoke only grants they are allowed to assign.
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
      return forbidden("Catalog access-management permission required");
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

    // Only administrators may revoke protected access.
    if (
      !canRevokeExistingCatalogGrant(managementAccess.policyContext, {
        role: existingAccess.role,
        extras: existingAccess.extraPermissions,
      })
    ) {
      return forbidden("Only catalog administrators can revoke this access");
    }

    if (isSelfCatalogAccessChange(currentUserId, targetUserId)) {
      return badRequest(
        "Cannot revoke your own access. Ask another admin or owner to do this."
      );
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
      role: existingAccess.role,
      details: {
        targetUserId,
        targetEmail: existingAccess.user.email,
        catalogId,
        role: existingAccess.role,
        extraPermissions: existingAccess.extraPermissions,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "catalog access", "revoke");
  }
}
