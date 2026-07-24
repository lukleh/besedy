import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  logCatalogAccessEvent,
  logPendingCatalogGrantEvent,
} from "@/lib/audit/logger";
import {
  AdminDeniedAdmissionReopenError,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { CreatePendingCatalogGrantSchema } from "@/lib/validation/schemas";
import {
  validateRequestBody,
  forbidden,
  notFound,
  conflict,
  handlePrismaError,
} from "@/lib/api";
import {
  canAttemptCatalogManagement,
  canGrantCatalogAccessLevel,
  canManageExistingCatalogAccessLevel,
} from "@/lib/policy/catalog";

export async function createPendingCatalogGrant(
  request: NextRequest,
  catalogId: string
) {
  try {
    const userId = await requireAuth();

    const managementAccess = await resolveCatalogManagementActor(catalogId, {
      userId,
      activeCatalogOnly: false,
    });
    if (!managementAccess.ok) {
      return managementAccess.response;
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    const bodyResult = await validateRequestBody(request, CreatePendingCatalogGrantSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { email, accessLevel, message } = bodyResult.data;

    if (!canGrantCatalogAccessLevel(managementAccess.policyContext, accessLevel)) {
      return forbidden("Only administrators can grant OWNER access");
    }

    const catalog = await prisma.workflowGroup.findUnique({
      where: { id: catalogId },
      select: { id: true, label: true },
    });

    if (!catalog) {
      return notFound("catalog");
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        catalogAccess: {
          where: { catalogId },
          select: { accessLevel: true },
        },
      },
    });

    if (existingUser?.catalogAccess && existingUser.catalogAccess.length > 0) {
      return conflict("User already has access to this catalog");
    }

    if (existingUser) {
      const newAccess = await prisma.catalogAccess.create({
        data: {
          userId: existingUser.id,
          catalogId,
          accessLevel,
          grantedById: userId,
          notes: message || "Added via catalog settings",
        },
      });

      await logCatalogAccessEvent({
        actorId: userId,
        action: "CATALOG_ACCESS_GRANTED",
        accessResourceId: newAccess.id,
        targetUserId: existingUser.id,
        targetEmail: email,
        catalogId,
        catalogLabel: catalog.label,
        accessLevel,
        details: {
          targetUserId: existingUser.id,
          email,
          catalogId,
          accessLevel,
          catalogLabel: catalog.label,
          userStatus: existingUser.status,
        },
      });

      return NextResponse.json({
        id: newAccess.id,
        email,
        accessLevel,
        catalogId,
        catalogLabel: catalog.label,
        userStatus: existingUser.status,
        isNewUser: false,
      });
    }

    const [existingAdmission, existingPendingGrant] = await Promise.all([
      prisma.portalAdmission.findUnique({
        where: { email },
        select: {
          status: true,
        },
      }),
      prisma.pendingCatalogGrant.findUnique({
        where: {
          email_catalogId: {
            email,
            catalogId,
          },
        },
        select: {
          accessLevel: true,
          status: true,
        },
      }),
    ]);

    if (
      existingPendingGrant &&
      !canManageExistingCatalogAccessLevel(
        managementAccess.policyContext,
        existingPendingGrant.accessLevel
      )
    ) {
      return forbidden("Only administrators can modify OWNER access");
    }

    if (existingAdmission?.status === "CLAIMED") {
      return conflict("User has already claimed portal access");
    }

    const isUpdatedPendingGrant = Boolean(existingPendingGrant);

    await prisma.$transaction(async (tx) => {
      const pendingAdmissionInput = {
        email,
        catalogId,
        accessLevel,
        createdById: userId,
        createdAt: new Date(),
        notes: message || "Added via catalog settings",
      };

      await syncPendingAdmissionState(
        pendingAdmissionInput,
        {
          allowAdminDeniedReopen: managementAccess.actor.isCatalogAdmin,
        },
        tx
      );
    });

    await logPendingCatalogGrantEvent({
      actorId: userId,
      action: isUpdatedPendingGrant
        ? "PENDING_CATALOG_GRANT_UPDATED"
        : "PENDING_CATALOG_GRANT_CREATED",
      resourceId: `${email}:${catalogId}`,
      email,
      catalogId,
      catalogLabel: catalog.label,
      accessLevel,
      details: {
        email,
        portalAdmissionResourceId: email,
        catalogId,
        accessLevel,
        catalogLabel: catalog.label,
      },
    });

    return NextResponse.json({
      id: email,
      email,
      accessLevel,
      catalogId,
      catalogLabel: catalog.label,
      userStatus: "PENDING",
      isNewUser: true,
      isUpdatedPendingGrant,
    });
  } catch (error) {
    if (error instanceof AdminDeniedAdmissionReopenError) {
      return forbidden("Only administrators can reopen admin-denied admissions");
    }
    return handlePrismaError(error, "pending catalog grant", "create");
  }
}
