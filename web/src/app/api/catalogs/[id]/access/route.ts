import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import {
  GRANTABLE_EXTRA_PERMISSIONS,
  grantFieldsForRole,
  mergeGrantableExtraPermissions,
} from "@/lib/policy/catalog-permissions";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  canManageCatalogConfiguration,
  canAttemptCatalogManagement,
  canGrantCatalogGrant,
  canManageCatalogGrantExtras,
  canManageExistingCatalogGrant,
  canRevokeExistingCatalogGrant,
  isSelfCatalogAccessChange,
  manageableCatalogRoles,
} from "@/lib/policy/catalog";
import {
  TimestampIdParamSchema,
  GrantAccessSchema,
} from "@/lib/validation/schemas";
import {
  validateMutationSource,
  validateParams,
  validateRequestBody,
  badRequest,
  forbidden,
  notFound,
  conflict,
  handlePrismaError,
} from "@/lib/api";
import { logCatalogAccessEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/access - List users with access to this catalog
 * Requires catalog access-management permission.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    // Check if catalog exists
    const catalog = await prisma.workflowGroup.findUnique({
      where: { id: catalogId },
      select: { id: true, label: true },
    });

    if (!catalog) {
      return notFound("catalog");
    }

    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("Catalog access-management permission required");
    }

    // Get all access grants for this catalog (including revoked)
    const accessList = await prisma.catalogAccess.findMany({
      where: { catalogId },
      select: {
        id: true,
        userId: true,
        accessLevel: true,
        role: true,
        extraPermissions: true,
        status: true,
        notes: true,
        createdAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            status: true,
          },
        },
        grantedBy: {
          select: { id: true, name: true, email: true },
        },
        revokedBy: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [
        { status: "asc" }, // ACTIVE first, then REVOKED
        { createdAt: "asc" },
      ],
    });

    return NextResponse.json({
      catalog,
      accessList: accessList.map((grant) => ({
        ...grant,
        canManage:
          !isSelfCatalogAccessChange(userId, grant.userId) &&
          canManageExistingCatalogGrant(managementAccess.policyContext, {
            level: grant.accessLevel,
            role: grant.role,
            extras: grant.extraPermissions,
          }),
        canRevoke:
          !isSelfCatalogAccessChange(userId, grant.userId) &&
          canRevokeExistingCatalogGrant(managementAccess.policyContext, {
            level: grant.accessLevel,
            role: grant.role,
            extras: grant.extraPermissions,
          }),
      })),
      canManageAccess: true,
      canManageCatalogConfig: canManageCatalogConfiguration(
        managementAccess.policyContext
      ),
      // The roles the actor may assign, so the client offers
      // exactly what the server will accept.
      manageableRoles: manageableCatalogRoles(managementAccess.policyContext),
      canManageExtras: canManageCatalogGrantExtras(
        managementAccess.policyContext
      ),
      grantableExtraPermissions: GRANTABLE_EXTRA_PERMISSIONS,
    });
  } catch (error) {
    return handlePrismaError(error, "catalog access", "fetch");
  }
}

/**
 * POST /api/catalogs/:id/access - Grant access to a user
 * Body: { userId: string, role: CatalogRole, extraPermissions?: string[], notes?: string, userName?: string }
 * Catalog administrators may grant any role and curated extras. Hosts may
 * grant only roles carrying no protected permission and may not grant extras.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // Keep the handler-level check as defense in depth for direct invocation
    // paths that bypass proxy enforcement, including route unit tests.
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    const currentUserId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const bodyResult = await validateRequestBody(request, GrantAccessSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { userId, role, extraPermissions, notes, userName } = bodyResult.data;

    // Check if catalog exists
    const catalog = await prisma.workflowGroup.findUnique({
      where: { id: catalogId },
      select: { id: true, label: true },
    });

    if (!catalog) {
      return notFound("catalog");
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });

    if (!targetUser) {
      return notFound("user");
    }

    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId: currentUserId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("Catalog access-management permission required");
    }

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

    if (isSelfCatalogAccessChange(currentUserId, userId)) {
      return badRequest(
        "Cannot grant yourself access. Ask another admin or owner to do this."
      );
    }

    // Check if user already has access (including revoked)
    const existingAccess = await prisma.catalogAccess.findUnique({
      where: {
        userId_catalogId: { userId, catalogId },
      },
    });

    if (existingAccess) {
      if (existingAccess.status === "ACTIVE") {
        return conflict(
          "User already has access to this catalog. Use PUT to update the grant."
        );
      }

      if (
        !canManageExistingCatalogGrant(managementAccess.policyContext, {
          level: existingAccess.accessLevel,
          role: existingAccess.role,
          extras: existingAccess.extraPermissions,
        })
      ) {
        return forbidden("Only catalog administrators can restore this access");
      }
    }

    const storedExtraPermissions = existingAccess
      ? mergeGrantableExtraPermissions(
          existingAccess.extraPermissions,
          extraPermissions
        )
      : extraPermissions;

    const grantedAccess = await prisma.$transaction(async (tx) => {
      if (userName !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: { name: userName },
        });
      }

      if (existingAccess) {
        // Restore revoked access with new level
        return tx.catalogAccess.update({
          where: {
            userId_catalogId: { userId, catalogId },
          },
          data: {
            ...grantFieldsForRole(role, storedExtraPermissions),
            status: "ACTIVE",
            notes: notes || null,
            grantedById: currentUserId,
            revokedById: null,
            revokedAt: null,
          },
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
            grantedBy: { select: { id: true, name: true, email: true } },
          },
        });
      }

      // Create new access grant
      return tx.catalogAccess.create({
        data: {
          userId,
          catalogId,
          ...grantFieldsForRole(role, storedExtraPermissions),
          notes: notes || null,
          grantedById: currentUserId,
        },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          grantedBy: { select: { id: true, name: true, email: true } },
        },
      });
    });

    // Audit log access grant
    await logCatalogAccessEvent({
      actorId: currentUserId,
      action: "CATALOG_ACCESS_GRANTED",
      accessResourceId: `${userId}:${catalogId}`,
      targetUserId: userId,
      targetEmail: targetUser.email,
      catalogId,
      catalogLabel: catalog.label,
      accessLevel: grantedAccess.accessLevel,
      details: {
        targetUserId: userId,
        targetEmail: targetUser.email,
        catalogId,
        role,
        extraPermissions: storedExtraPermissions,
        restored: !!existingAccess,
        userNameUpdated: userName !== undefined,
      },
    });

    return NextResponse.json(grantedAccess, { status: 201 });
  } catch (error) {
    return handlePrismaError(error, "catalog access", "create");
  }
}
