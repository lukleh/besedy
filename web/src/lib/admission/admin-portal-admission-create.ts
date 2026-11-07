import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AddUserSchema } from "@/lib/validation/schemas";
import { validateRequestBody, conflict, notFound, handlePrismaError } from "@/lib/api";
import { logPendingCatalogGrantEvent } from "@/lib/audit/logger";
import { syncPendingAdmissionState } from "@/lib/admission/pending-admission-sync";
import { requireAdminCapability } from "@/lib/access/require-admin";

export async function createPortalAdmission(request: NextRequest) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to add users",
    });

    const bodyResult = await validateRequestBody(request, AddUserSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { email, catalogId, role, extraPermissions } = bodyResult.data;

    const catalog = await prisma.workflowGroup.findUnique({
      where: { id: catalogId },
      select: { isActive: true },
    });
    if (!catalog?.isActive) return notFound("catalog");

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return conflict("A user with this email already exists");
    }

    const existingAdmission = await prisma.portalAdmission.findUnique({
      where: { email },
      select: {
        status: true,
      },
    });
    if (existingAdmission?.status === "CLAIMED") {
      return conflict("This email has already claimed portal access");
    }

    await prisma.$transaction(async (tx) => {
      const pendingAdmissionInput = {
        email,
        createdById: userId,
        createdAt: new Date(),
        catalogId,
        role,
        extraPermissions,
        notes: null,
      };

      await syncPendingAdmissionState(
        pendingAdmissionInput,
        {
          allowAdminDeniedReopen: true,
        },
        tx
      );
    });

    await logPendingCatalogGrantEvent({
      actorId: userId,
      action: "PENDING_CATALOG_GRANT_CREATED",
      resourceId: `${email}:${catalogId}`,
      email,
      catalogId,
      role,
      details: { email, catalogId, role, extraPermissions },
    });

    return NextResponse.json({
      id: email,
      email,
      status: "PENDING",
      catalogAccess: { catalogId, role, extraPermissions },
    });
  } catch (error) {
    return handlePrismaError(error, "portal admission", "create");
  }
}
