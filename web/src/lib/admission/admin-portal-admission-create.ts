import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AddUserSchema } from "@/lib/validation/schemas";
import {
  validateRequestBody,
  conflict,
  handlePrismaError,
} from "@/lib/api";
import {
  logPendingCatalogGrantEvent,
  logPortalAdmissionEvent,
} from "@/lib/audit/logger";
import {
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { requireAdminCapability } from "@/lib/access/require-admin";

export async function createPortalAdmission(request: NextRequest) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to add users",
    });

    const bodyResult = await validateRequestBody(request, AddUserSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { email, catalogId, accessLevel } = bodyResult.data;

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
    const existingAdmissionStatus = existingAdmission?.status ?? null;

    if (existingAdmission?.status === "CLAIMED") {
      return conflict("This email has already claimed portal access");
    }

    await prisma.$transaction(async (tx) => {
      const pendingAdmissionInput = {
        email,
        createdById: userId,
        createdAt: new Date(),
        catalogId: catalogId ?? null,
        accessLevel: catalogId && accessLevel ? accessLevel : null,
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

    if (catalogId && accessLevel) {
      await logPendingCatalogGrantEvent({
        actorId: userId,
        action: "PENDING_CATALOG_GRANT_CREATED",
        resourceId: `${email}:${catalogId}`,
        email,
        catalogId,
        accessLevel,
        details: {
          email,
          catalogId,
          accessLevel,
        },
      });
    } else {
      await logPortalAdmissionEvent({
        actorId: userId,
        action:
          existingAdmissionStatus === "PENDING"
            ? "PORTAL_ADMISSION_UPDATED"
            : "PORTAL_ADMISSION_CREATED",
        resourceId: email,
        email,
        details: { email },
      });
    }

    return NextResponse.json({
      id: email,
      email,
      status: "PENDING",
      catalogAccess: catalogId ? { catalogId, accessLevel } : null,
    });
  } catch (error) {
    return handlePrismaError(error, "portal admission", "create");
  }
}
