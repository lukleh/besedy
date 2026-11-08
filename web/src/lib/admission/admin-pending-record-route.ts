import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  badRequest,
  notFound,
  handlePrismaError,
  conflict,
  validateRequestBody,
} from "@/lib/api";
import {
  logPendingCatalogGrantEvent,
  logPortalAdmissionEvent,
} from "@/lib/audit/logger";
import {
  buildPendingGrantPresentation,
  loadPendingAdmissionState,
} from "@/lib/admission/admin-pending-record-shared";
import {
  PendingAdmissionUnavailableError,
  revokePendingAdmissionState,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { canonicalizeEmail } from "@/lib/email";
import { z } from "zod";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { requireArchive } from "@/lib/archive";
import {
  CatalogRoleSchema,
  GrantableExtraPermissionSchema,
} from "@/lib/validation/schemas";

const UpdatePortalAdmissionSchema = z.object({
  role: CatalogRoleSchema.optional(),
  extraPermissions: z.array(GrantableExtraPermissionSchema).optional(),
  catalogId: z.string().min(1).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function getAdminPendingRecord(id: string) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });
    const canonicalEmail = canonicalizeEmail(id);
    const { admission, pendingGrants } =
      await loadPendingAdmissionState(canonicalEmail);
    if (!admission) return notFound("portal admission");
    const grant = pendingGrants[0] ?? null;
    const presentation = await buildPendingGrantPresentation(
      pendingGrants,
      admission.admittedById ?? grant?.grantedById
    );
    return NextResponse.json({
      id: canonicalEmail,
      email: admission.email,
      status: "PENDING",
      pendingResource: "portal_admission" as const,
      pendingGrants: presentation.pendingGrantResponses,
      pendingGrantCount: presentation.pendingGrantCount,
      catalogNames: presentation.catalogNames,
      catalogId: grant?.catalogId ?? null,
      catalogLabel: presentation.singleCatalogLabel,
      role: grant?.role ?? null,
      extraPermissions: grant?.extraPermissions ?? [],
      invitedAt: admission.admittedAt.toISOString(),
      consumedAt: null,
      invitedBy: presentation.actor,
      consumedBy: null,
      notes: admission.notes ?? grant?.notes ?? null,
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
    const { admission, pendingGrants } =
      await loadPendingAdmissionState(canonicalEmail);
    if (!admission) return notFound("portal admission");
    const grant = pendingGrants[0] ?? null;
    await prisma.$transaction(async (tx) => {
      await revokePendingAdmissionState(
        {
          email: canonicalEmail,
          catalogId: grant?.catalogId ?? null,
          role: grant?.role ?? null,
          extraPermissions: grant?.extraPermissions ?? [],
          createdById: admission.admittedById,
          createdAt: admission.admittedAt,
          notes: admission.notes,
        },
        {
          actorId: userId,
          reason: "ADMIN_DENIED",
          ...(grant
            ? { expectedGrant: { ...grant, status: "PENDING" as const } }
            : {}),
        },
        tx
      );
    });
    await logPortalAdmissionEvent({
      actorId: userId,
      action: "PORTAL_ADMISSION_REVOKED",
      resourceId: canonicalEmail,
      email: canonicalEmail,
      catalogId: grant?.catalogId ?? null,
      details: {
        email: canonicalEmail,
        catalogId: grant?.catalogId ?? null,
        role: grant?.role ?? null,
        extraPermissions: grant?.extraPermissions ?? [],
        pendingGrantCount: pendingGrants.length,
        revocationReason: "ADMIN_DENIED",
        revokedGrants: pendingGrants.map(
          ({ catalogId, role, extraPermissions }) => ({
            catalogId,
            role,
            extraPermissions,
          })
        ),
      },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PendingAdmissionUnavailableError)
      return conflict(error.message);
    return handlePrismaError(error, "portal admission", "delete");
  }
}

/** Update the bound invitation, or edit legacy unbacked admission notes. */
export async function patchAdminPendingRecord(
  id: string,
  request: NextRequest
) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to update portal admissions",
    });
    const bodyResult = await validateRequestBody(
      request,
      UpdatePortalAdmissionSchema
    );
    if (!bodyResult.success) return bodyResult.response;
    const { role, extraPermissions, catalogId, notes } = bodyResult.data;
    const archive = await requireArchive();
    if (catalogId && catalogId !== archive.id) return notFound("catalog");

    const canonicalEmail = canonicalizeEmail(id);
    const { admission, pendingGrants } =
      await loadPendingAdmissionState(canonicalEmail);
    if (!admission) return notFound("portal admission");
    const grant = pendingGrants[0] ?? null;
    if (catalogId === null) {
      return badRequest(
        "Pending invitations must retain content access. Revoke the invitation instead."
      );
    }
    const changesGrant =
      role !== undefined ||
      extraPermissions !== undefined ||
      catalogId !== undefined;
    // A legacy sign-in-only admission is not promoted by notes or extras edits.
    if (!grant && changesGrant && !role) {
      return badRequest("A role is required to assign archive access.");
    }
    const nextRole = role ?? grant?.role ?? null;
    const nextExtras = extraPermissions ?? grant?.extraPermissions ?? [];
    const previousNotes = admission.notes ?? grant?.notes ?? null;
    const nextNotes = notes !== undefined ? notes : previousNotes;

    // Legacy admissions can retain a revoked/consumed row hidden from the
    // pending read model. Explicit role assignment must update that row with
    // the same conditional guard as a pending grant, rather than insert again.
    const expectedGrant = grant
      ? { ...grant, status: "PENDING" as const }
      : role
        ? await prisma.pendingCatalogGrant.findUnique({
            where: {
              email_catalogId: { email: canonicalEmail, catalogId: archive.id },
            },
            select: { role: true, extraPermissions: true, status: true },
          })
        : null;
    if (!grant && expectedGrant?.status === "PENDING") {
      throw new PendingAdmissionUnavailableError();
    }

    await prisma.$transaction(async (tx) => {
      if (changesGrant && nextRole) {
        await syncPendingAdmissionState(
          {
            email: canonicalEmail,
            catalogId: archive.id,
            role: nextRole,
            extraPermissions: nextExtras,
            createdById: grant?.grantedById ?? userId,
            createdAt: grant?.grantedAt ?? new Date(),
            notes: nextNotes,
          },
          {
            allowAdminDeniedReopen: true,
            requirePending: true,
            expectedGrant,
          },
          tx
        );
      } else {
        // Keep this conditional: a stale notes save must not reopen a claimed/revoked admission.
        const updated = await tx.portalAdmission.updateMany({
          where: { email: canonicalEmail, status: "PENDING" },
          data: { notes: nextNotes },
        });
        if (updated.count !== 1) throw new PendingAdmissionUnavailableError();
        if (grant) {
          await tx.pendingCatalogGrant.updateMany({
            where: {
              email: canonicalEmail,
              catalogId: archive.id,
              status: "PENDING",
            },
            data: { notes: nextNotes },
          });
        }
      }
    });

    if (changesGrant && nextRole) {
      await logPendingCatalogGrantEvent({
        actorId: userId,
        action: "PENDING_CATALOG_GRANT_UPDATED",
        resourceId: `${canonicalEmail}:${archive.id}`,
        email: canonicalEmail,
        catalogId: archive.id,
        role: nextRole,
        details: {
          email: canonicalEmail,
          previousCatalogId: grant?.catalogId ?? null,
          newCatalogId: archive.id,
          previousRole: grant?.role ?? null,
          newRole: nextRole,
          previousExtraPermissions: grant?.extraPermissions ?? [],
          newExtraPermissions: nextExtras,
          previousNotes,
          newNotes: nextNotes,
        },
      });
    } else {
      await logPortalAdmissionEvent({
        actorId: userId,
        action: "PORTAL_ADMISSION_UPDATED",
        resourceId: canonicalEmail,
        email: canonicalEmail,
        catalogId: grant?.catalogId ?? null,
        details: { email: canonicalEmail, previousNotes, newNotes: nextNotes },
      });
    }

    // Use the same bound read model for GET and PATCH responses.
    const updated = await loadPendingAdmissionState(canonicalEmail);
    const presentation = await buildPendingGrantPresentation(
      updated.pendingGrants
    );
    const updatedGrant = updated.pendingGrants[0] ?? null;
    return NextResponse.json({
      id: canonicalEmail,
      email: canonicalEmail,
      pendingResource: "portal_admission" as const,
      pendingGrants: presentation.pendingGrantResponses,
      pendingGrantCount: presentation.pendingGrantCount,
      catalogNames: presentation.catalogNames,
      catalogId: updatedGrant?.catalogId ?? null,
      catalogLabel: presentation.singleCatalogLabel,
      role: updatedGrant?.role ?? null,
      extraPermissions: updatedGrant?.extraPermissions ?? [],
      notes: nextNotes,
    });
  } catch (error) {
    if (error instanceof PendingAdmissionUnavailableError)
      return conflict(error.message);
    return handlePrismaError(error, "portal admission", "update");
  }
}
