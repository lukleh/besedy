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
  buildPendingAdmissionPresentation,
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
    const { admission, grant, archive } = await loadPendingAdmissionState(
      canonicalizeEmail(id),
    );
    if (!admission) return notFound("portal admission");
    return NextResponse.json({
      ...(await buildPendingAdmissionPresentation(admission, grant, archive)),
      pendingResource: "portal_admission" as const,
      consumedAt: null,
      consumedBy: null,
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
    const { admission, grant } =
      await loadPendingAdmissionState(canonicalEmail);
    if (!admission) return notFound("portal admission");
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
        tx,
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
        pendingGrantCount: grant ? 1 : 0,
        revocationReason: "ADMIN_DENIED",
        revokedGrants: grant
          ? [
              {
                catalogId: grant.catalogId,
                role: grant.role,
                extraPermissions: grant.extraPermissions,
              },
            ]
          : [],
      },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PendingAdmissionUnavailableError)
      return conflict(error.message);
    return handlePrismaError(error, "portal admission", "delete");
  }
}

/** Only role-backed invitations can be edited; historical admissions remain revocable. */
export async function patchAdminPendingRecord(
  id: string,
  request: NextRequest,
) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to update portal admissions",
    });
    const bodyResult = await validateRequestBody(
      request,
      UpdatePortalAdmissionSchema,
    );
    if (!bodyResult.success) return bodyResult.response;
    const { role, extraPermissions, catalogId, notes } = bodyResult.data;
    const archive = await requireArchive();
    if (catalogId && catalogId !== archive.id) return notFound("catalog");
    if (catalogId === null)
      return badRequest(
        "Pending invitations must retain content access. Revoke the invitation instead.",
      );

    const canonicalEmail = canonicalizeEmail(id);
    const { admission, grant } =
      await loadPendingAdmissionState(canonicalEmail);
    if (!admission) return notFound("portal admission");
    if (!grant)
      return conflict(
        "This invitation has no archive access. Revoke it and create a new invitation with a role.",
      );
    const nextRole = role ?? grant.role;
    const nextExtras = extraPermissions ?? grant.extraPermissions;
    const previousNotes = admission.notes ?? grant.notes;
    const nextNotes = notes !== undefined ? notes : previousNotes;

    await prisma.$transaction(async (tx) => {
      await syncPendingAdmissionState(
        {
          email: canonicalEmail,
          catalogId: archive.id,
          role: nextRole,
          extraPermissions: nextExtras,
          createdById: grant.grantedById,
          createdAt: grant.grantedAt,
          notes: nextNotes,
        },
        {
          allowAdminDeniedReopen: true,
          requirePending: true,
          expectedGrant: { ...grant, status: "PENDING" as const },
        },
        tx,
      );
    });
    await logPendingCatalogGrantEvent({
      actorId: userId,
      action: "PENDING_CATALOG_GRANT_UPDATED",
      resourceId: `${canonicalEmail}:${archive.id}`,
      email: canonicalEmail,
      catalogId: archive.id,
      role: nextRole,
      details: {
        email: canonicalEmail,
        previousRole: grant.role,
        newRole: nextRole,
        previousExtraPermissions: grant.extraPermissions,
        newExtraPermissions: nextExtras,
        previousNotes,
        newNotes: nextNotes,
      },
    });
    return NextResponse.json({
      ...(await buildPendingAdmissionPresentation(
        { ...admission, notes: nextNotes },
        {
          ...grant,
          role: nextRole,
          extraPermissions: nextExtras,
          notes: nextNotes,
        },
        archive,
      )),
      pendingResource: "portal_admission" as const,
    });
  } catch (error) {
    if (error instanceof PendingAdmissionUnavailableError)
      return conflict(error.message);
    return handlePrismaError(error, "portal admission", "update");
  }
}
