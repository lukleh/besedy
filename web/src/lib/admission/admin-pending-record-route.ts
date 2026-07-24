import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { forbidden, notFound, handlePrismaError, conflict, validateRequestBody } from "@/lib/api";
import {
  logPendingCatalogGrantEvent,
  logPortalAdmissionEvent,
} from "@/lib/audit/logger";
import {
  buildPendingGrantPresentation,
  highestPendingAccessLevel,
  loadPendingAdmissionState,
} from "@/lib/admission/admin-pending-record-shared";
import {
  AdminDeniedAdmissionReopenError,
  revokePendingAdmissionState,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { canonicalizeEmail } from "@/lib/email";
import { z } from "zod";
import { requireAdminCapability } from "@/lib/access/require-admin";

// Owns the admin item-route contract for pending portal admissions.
// Shared lookup and response-shaping helpers live next door so this file stays
// focused on request validation, state transitions, and audit logging.

const UpdatePortalAdmissionSchema = z.object({
  accessLevel: z.enum(["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"]).optional(),
  catalogId: z.string().min(1).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function getAdminPendingRecord(id: string) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const canonicalEmail = canonicalizeEmail(id);
    const { admission, pendingGrants } = await loadPendingAdmissionState(canonicalEmail);

    if (!admission || admission.status !== "PENDING") {
      return notFound("portal admission");
    }

    const newestPendingGrant = pendingGrants[0] ?? null;
    const actorId = admission.admittedById ?? newestPendingGrant?.grantedById ?? null;
    const {
      actor,
      catalogNames,
      pendingGrantCount,
      pendingGrantResponses,
      singleCatalogGrant,
      singleCatalogLabel,
    } = await buildPendingGrantPresentation(pendingGrants, actorId);

    return NextResponse.json({
      id: canonicalEmail,
      email: admission.email,
      status: "PENDING",
      pendingResource: "portal_admission" as const,
      pendingGrants: pendingGrantResponses,
      pendingGrantCount,
      catalogNames,
      catalogId: singleCatalogGrant?.catalogId ?? null,
      catalogLabel: singleCatalogLabel,
      accessLevel: singleCatalogGrant?.accessLevel ?? null,
      invitedAt: admission.admittedAt.toISOString(),
      consumedAt: null,
      invitedBy: actor,
      consumedBy: null,
      notes: admission.notes ?? newestPendingGrant?.notes ?? null,
    });
  } catch (error) {
    return handlePrismaError(error, "portal admission", "fetch");
  }
}

export async function deleteAdminPendingRecord(id: string) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to revoke portal admissions",
    });

    const canonicalEmail = canonicalizeEmail(id);
    const { admission, pendingGrants } = await loadPendingAdmissionState(canonicalEmail);

    if (!admission || admission.status !== "PENDING") {
      return notFound("portal admission");
    }

    const newestPendingGrant = pendingGrants[0] ?? null;
    const pendingGrantCount = pendingGrants.length;
    const pendingAdmissionInput = {
      email: canonicalEmail,
      catalogId: newestPendingGrant?.catalogId ?? null,
      accessLevel: newestPendingGrant?.accessLevel ?? null,
      createdById:
        admission.admittedById ??
        newestPendingGrant?.grantedById ??
        null,
      createdAt:
        admission.admittedAt ??
        newestPendingGrant?.grantedAt ??
        new Date(),
      notes: admission.notes ?? newestPendingGrant?.notes ?? null,
    };

    await prisma.$transaction(async (tx) =>
      {
        await revokePendingAdmissionState(
          pendingAdmissionInput,
          {
            actorId: userId,
            reason: "ADMIN_DENIED",
            revokeAllPendingGrantsForEmail: true,
          },
          tx
        );
      }
    );

    await logPortalAdmissionEvent({
      actorId: userId,
      action: "PORTAL_ADMISSION_REVOKED",
      resourceId: canonicalEmail,
      email: canonicalEmail,
      catalogId: pendingGrantCount === 1 ? newestPendingGrant?.catalogId ?? null : null,
      details: {
        email: canonicalEmail,
        catalogId: pendingGrantCount === 1 ? newestPendingGrant?.catalogId ?? null : null,
        accessLevel: pendingGrantCount === 1 ? newestPendingGrant?.accessLevel ?? null : null,
        pendingGrantCount,
        revocationReason: "ADMIN_DENIED",
        revokedGrants: pendingGrants.map((grant) => ({
          catalogId: grant.catalogId,
          accessLevel: grant.accessLevel,
        })),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "portal admission", "delete");
  }
}

/**
 * PATCH /api/admin/portal-admissions/[email] - Update pending portal admission
 * Allows editing access level, catalog, and notes before admission is claimed
 */
export async function patchAdminPendingRecord(id: string, request: NextRequest) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to update portal admissions",
    });

    const bodyResult = await validateRequestBody(request, UpdatePortalAdmissionSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { accessLevel, catalogId, notes } = bodyResult.data;

    const canonicalEmail = canonicalizeEmail(id);
    const { admission, pendingGrants } = await loadPendingAdmissionState(canonicalEmail);

    if (!admission || admission.status !== "PENDING") {
      return notFound("portal admission");
    }

    const newestPendingGrant = pendingGrants[0] ?? null;
    const pendingGrantCount = pendingGrants.length;
    const multiGrantAdmissionEdit = pendingGrantCount > 1;
    const notesOnlyAdmissionEdit =
      multiGrantAdmissionEdit && accessLevel === undefined && catalogId === undefined;

    if (multiGrantAdmissionEdit && !notesOnlyAdmissionEdit) {
      return conflict(
        "Cannot edit multiple pending catalog grants from the admin admission view. Use catalog settings for grant-specific edits."
      );
    }

    if (catalogId) {
      const catalog = await prisma.workflowGroup.findUnique({
        where: { id: catalogId },
        select: { id: true },
      });
      if (!catalog) {
        return notFound("catalog");
      }
    }

    const previousCatalogId = multiGrantAdmissionEdit
      ? null
      : newestPendingGrant?.catalogId ?? null;
    const previousAccessLevel = multiGrantAdmissionEdit
      ? highestPendingAccessLevel(pendingGrants)
      : newestPendingGrant?.accessLevel ?? null;
    const previousNotes = admission.notes ?? newestPendingGrant?.notes ?? null;
    const previousCreatedById =
      admission.admittedById ??
      newestPendingGrant?.grantedById ??
      null;
    const previousCreatedAt =
      admission.admittedAt ??
      newestPendingGrant?.grantedAt ??
      new Date();
    const previousPendingGrantInput = newestPendingGrant
      ? {
          email: canonicalEmail,
          catalogId: newestPendingGrant.catalogId,
          accessLevel: newestPendingGrant.accessLevel,
          createdById: newestPendingGrant.grantedById,
          createdAt: newestPendingGrant.grantedAt,
          notes: newestPendingGrant.notes ?? null,
        }
      : null;

    const nextCatalogId = multiGrantAdmissionEdit
      ? null
      : catalogId !== undefined
        ? catalogId
        : previousCatalogId;
    const nextAccessLevel = multiGrantAdmissionEdit
      ? previousAccessLevel
      : accessLevel !== undefined
        ? accessLevel
        : previousAccessLevel;
    const normalizedCatalogId = nextCatalogId && nextAccessLevel ? nextCatalogId : null;
    const normalizedAccessLevel = nextCatalogId && nextAccessLevel ? nextAccessLevel : null;
    const normalizedNotes = notes !== undefined ? notes : previousNotes;
    const shouldRevokePreviousGrant =
      !multiGrantAdmissionEdit &&
      previousPendingGrantInput !== null &&
      previousPendingGrantInput.catalogId !== normalizedCatalogId;

    const updateResult = await prisma.$transaction(async (tx) => {
      if (multiGrantAdmissionEdit) {
        const updatedAdmission = await tx.portalAdmission.update({
          where: { email: canonicalEmail },
          data: {
            notes: normalizedNotes,
          },
          select: {
            email: true,
            notes: true,
          },
        });

        return {
          id: canonicalEmail,
          email: updatedAdmission.email,
          catalogId: null,
          accessLevel: highestPendingAccessLevel(pendingGrants),
          notes: updatedAdmission.notes,
        };
      }

      const pendingAdmissionInput = {
        email: canonicalEmail,
        catalogId: normalizedCatalogId,
        accessLevel: normalizedAccessLevel,
        createdById: previousCreatedById,
        createdAt: previousCreatedAt,
        notes: normalizedNotes,
      };

      await syncPendingAdmissionState(
        pendingAdmissionInput,
        {
          allowAdminDeniedReopen: true,
        },
        tx
      );

      if (shouldRevokePreviousGrant && previousPendingGrantInput) {
        await revokePendingAdmissionState(
          previousPendingGrantInput,
          {
            actorId: userId,
            reason: "LAST_SPONSOR_REMOVED",
          },
          tx
        );
      }

      return {
        id: canonicalEmail,
        email: canonicalEmail,
        catalogId: normalizedCatalogId,
        accessLevel: normalizedAccessLevel,
        notes: normalizedNotes,
      };
    });

    const {
      catalogNames: responseCatalogNames,
      pendingGrantResponses: responsePendingGrants,
    } = multiGrantAdmissionEdit
      ? await buildPendingGrantPresentation(pendingGrants)
      : { catalogNames: [], pendingGrantResponses: [] };
    const grantSpecificUpdate = !multiGrantAdmissionEdit && !!(normalizedCatalogId && normalizedAccessLevel);

    if (grantSpecificUpdate && normalizedCatalogId) {
      await logPendingCatalogGrantEvent({
        actorId: userId,
        action: "PENDING_CATALOG_GRANT_UPDATED",
        resourceId: `${canonicalEmail}:${normalizedCatalogId}`,
        email: canonicalEmail,
        catalogId: normalizedCatalogId,
        accessLevel: normalizedAccessLevel,
        details: {
          email: canonicalEmail,
          previousCatalogId,
          newCatalogId: normalizedCatalogId,
          previousAccessLevel,
          pendingGrantCount,
          newAccessLevel: normalizedAccessLevel,
          previousNotes,
          newNotes: normalizedNotes,
        },
      });
    } else {
      await logPortalAdmissionEvent({
        actorId: userId,
        action: "PORTAL_ADMISSION_UPDATED",
        resourceId: canonicalEmail,
        email: canonicalEmail,
        details: {
          email: canonicalEmail,
          previousCatalogId,
          previousAccessLevel,
          pendingGrantCount,
          previousNotes,
          newNotes: normalizedNotes,
        },
      });
    }

    const catalog = updateResult.catalogId
      ? await prisma.workflowGroup.findUnique({
          where: { id: updateResult.catalogId },
          select: { id: true, label: true },
        })
      : null;

    return NextResponse.json({
      id: canonicalEmail,
      email: updateResult.email,
      pendingResource: "portal_admission" as const,
      pendingGrants:
        multiGrantAdmissionEdit
          ? responsePendingGrants
          : normalizedCatalogId && normalizedAccessLevel
            ? [
                {
                  catalogId: normalizedCatalogId,
                  catalogLabel: catalog?.label || normalizedCatalogId,
                  accessLevel: normalizedAccessLevel,
                  grantedAt: previousCreatedAt.toISOString(),
                  grantedBy:
                    previousCreatedById
                      ? (await prisma.user.findUnique({
                          where: { id: previousCreatedById },
                          select: { id: true, name: true, email: true },
                        })) ?? null
                      : null,
                  notes: normalizedNotes,
                },
              ]
            : [],
      pendingGrantCount:
        multiGrantAdmissionEdit
          ? pendingGrantCount
          : normalizedCatalogId && normalizedAccessLevel
            ? 1
            : 0,
      catalogNames:
        multiGrantAdmissionEdit
          ? responseCatalogNames
          : normalizedCatalogId
            ? [catalog?.label || normalizedCatalogId]
            : [],
      catalogId: multiGrantAdmissionEdit ? null : updateResult.catalogId,
      catalogLabel: multiGrantAdmissionEdit ? null : catalog?.label || updateResult.catalogId,
      accessLevel: multiGrantAdmissionEdit
        ? highestPendingAccessLevel(pendingGrants)
        : updateResult.accessLevel,
      notes: updateResult.notes,
    });
  } catch (error) {
    if (error instanceof AdminDeniedAdmissionReopenError) {
      return forbidden("Only administrators can reopen admin-denied admissions");
    }
    return handlePrismaError(error, "portal admission", "update");
  }
}
