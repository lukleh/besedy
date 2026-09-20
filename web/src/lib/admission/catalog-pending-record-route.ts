import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { logPendingCatalogGrantEvent } from "@/lib/audit/logger";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  AdminDeniedAdmissionReopenError,
  revokePendingAdmissionState,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { canonicalizeEmail } from "@/lib/email";
import {
  validateRequestBody,
  forbidden,
  notFound,
  handlePrismaError,
} from "@/lib/api";
import { z } from "zod";
import {
  CatalogRoleSchema,
  GrantableExtraPermissionSchema,
} from "@/lib/validation/schemas";
import {
  canAttemptCatalogManagement,
  canGrantCatalogGrant,
  canManageExistingCatalogGrant,
} from "@/lib/policy/catalog";

const UpdatePendingCatalogGrantSchema = z.object({
  role: CatalogRoleSchema,
  extraPermissions: z
    .array(GrantableExtraPermissionSchema)
    .optional()
    .default([]),
  notes: z.string().max(500).optional().nullable(),
});

export async function deletePendingCatalogRecord(
  catalogId: string,
  email: string
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

    if (!managementAccess.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("Catalog access-management permission required");
    }

    const pendingEmail = canonicalizeEmail(email);
    const pendingGrant = await prisma.pendingCatalogGrant.findUnique({
      where: {
        email_catalogId: {
          email: pendingEmail,
          catalogId,
        },
      },
      select: {
        email: true,
        catalogId: true,
        role: true,
        extraPermissions: true,
        grantedById: true,
        grantedAt: true,
        notes: true,
      },
    });

    if (!pendingGrant) {
      return notFound("pending catalog grant");
    }

    if (
      !canManageExistingCatalogGrant(managementAccess.policyContext, {
        role: pendingGrant.role,
        extras: pendingGrant.extraPermissions,
      })
    ) {
      return forbidden("Only catalog administrators can revoke this access");
    }

    await prisma.$transaction(async (tx) => {
      await revokePendingAdmissionState(
        {
          email: pendingGrant.email,
          catalogId: pendingGrant.catalogId,
          role: pendingGrant.role,
          extraPermissions: pendingGrant.extraPermissions,
          createdById: pendingGrant.grantedById,
          createdAt: pendingGrant.grantedAt,
          notes: pendingGrant.notes,
        },
        {
          actorId: userId,
          reason: "LAST_SPONSOR_REMOVED",
        },
        tx
      );
    });

    await logPendingCatalogGrantEvent({
      actorId: userId,
      action: "PENDING_CATALOG_GRANT_REVOKED",
      resourceId: `${pendingGrant.email}:${catalogId}`,
      email: pendingGrant.email,
      catalogId: pendingGrant.catalogId,
      role: pendingGrant.role,
      details: {
        email: pendingGrant.email,
        catalogId: pendingGrant.catalogId,
        role: pendingGrant.role,
        extraPermissions: pendingGrant.extraPermissions,
        revocationReason: "LAST_SPONSOR_REMOVED",
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "pending catalog grant", "delete");
  }
}

export async function updatePendingCatalogRecord(
  catalogId: string,
  email: string,
  request: NextRequest
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

    if (!managementAccess.actor.catalogExists) {
      return notFound("catalog");
    }

    if (!canAttemptCatalogManagement(managementAccess.policyContext)) {
      return forbidden("Catalog access-management permission required");
    }

    const bodyResult = await validateRequestBody(
      request,
      UpdatePendingCatalogGrantSchema
    );
    if (!bodyResult.success) return bodyResult.response;
    const { role, extraPermissions, notes } = bodyResult.data;

    const pendingEmail = canonicalizeEmail(email);
    const pendingGrant = await prisma.pendingCatalogGrant.findUnique({
      where: {
        email_catalogId: {
          email: pendingEmail,
          catalogId,
        },
      },
      select: {
        email: true,
        catalogId: true,
        role: true,
        extraPermissions: true,
        grantedById: true,
        grantedAt: true,
        notes: true,
      },
    });

    if (!pendingGrant) {
      return notFound("pending catalog grant");
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

    if (
      !canManageExistingCatalogGrant(managementAccess.policyContext, {
        role: pendingGrant.role,
        extras: pendingGrant.extraPermissions,
      })
    ) {
      return forbidden("Only catalog administrators can modify this access");
    }

    const normalizedNotes = notes ?? null;

    await prisma.$transaction(async (tx) => {
      const pendingAdmissionInput = {
        email: pendingGrant.email,
        catalogId: pendingGrant.catalogId,
        role,
        extraPermissions,
        createdById: pendingGrant.grantedById,
        createdAt: pendingGrant.grantedAt,
        notes: normalizedNotes,
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
      action: "PENDING_CATALOG_GRANT_UPDATED",
      resourceId: `${pendingGrant.email}:${catalogId}`,
      email: pendingGrant.email,
      catalogId,
      role,
      details: {
        email: pendingGrant.email,
        catalogId,
        previousRole: pendingGrant.role,
        previousExtraPermissions: pendingGrant.extraPermissions,
        newRole: role,
        newExtraPermissions: extraPermissions,
        previousNotes: pendingGrant.notes,
        newNotes: normalizedNotes,
      },
    });

    return NextResponse.json({
      id: pendingGrant.email,
      email: pendingGrant.email,
      role,
      extraPermissions,
      notes: normalizedNotes,
    });
  } catch (error) {
    if (error instanceof AdminDeniedAdmissionReopenError) {
      return forbidden(
        "Only administrators can reopen admin-denied admissions"
      );
    }
    return handlePrismaError(error, "pending catalog grant", "update");
  }
}
