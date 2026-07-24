import { NextRequest, NextResponse } from "next/server";
import { isSuperadmin } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { UserStatus } from "@/generated/prisma/client";
import { UserIdParamSchema, UpdateUserSchema } from "@/lib/validation/schemas";
import { validateParams, validateRequestBody, forbidden, notFound, badRequest, handlePrismaError } from "@/lib/api";
import { logUserEvent, logUserLifecycleEvent } from "@/lib/audit/logger";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/users/:id - Get user details
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const paramsResult = validateParams(await params, UserIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        invitedBy: {
          select: { id: true, name: true, email: true },
        },
        catalogAccess: {
          where: {
            status: "ACTIVE",
          },
          include: {
            catalog: {
              select: { id: true, label: true },
            },
          },
        },
      },
    });

    if (!user) {
      return notFound("user");
    }

    if (user.email) {
      const admission = await prisma.portalAdmission.findUnique({
        where: { email: user.email },
        select: {
          admittedAt: true,
          admittedBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return NextResponse.json({
        ...user,
        invitedBy: admission?.admittedBy ?? user.invitedBy,
        invitedAt: admission?.admittedAt ?? user.invitedAt,
      });
    }

    return NextResponse.json(user);
  } catch (error) {
    return handlePrismaError(error, "user", "fetch");
  }
}

/**
 * DELETE /api/admin/users/:id - Permanently delete a user
 * Deletes the user and all related data (sessions, accounts, catalog access).
 * Clears foreign key references from admission and access lifecycle rows.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { userId: currentUserId } = await requireAdminCapability({
      message: "Unauthorized",
    });

    const paramsResult = validateParams(await params, UserIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    // Get target user
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isSuperadmin: true, email: true },
    });

    if (!targetUser) {
      return notFound("user");
    }

    // Prevent deleting superadmin users
    if (targetUser.isSuperadmin) {
      return forbidden("Cannot delete superadmin users");
    }

    // Prevent self-deletion
    if (currentUserId === id) {
      return badRequest("Cannot delete yourself");
    }

    // Delete user and clear references in a transaction
    await prisma.$transaction([
      // Delete all sessions first (immediate logout)
      prisma.session.deleteMany({ where: { userId: id } }),
      // Clear invitedById references
      prisma.user.updateMany({
        where: { invitedById: id },
        data: { invitedById: null },
      }),
      // Clear grantedById references
      prisma.catalogAccess.updateMany({
        where: { grantedById: id },
        data: { grantedById: null },
      }),
      // Clear revokedById references
      prisma.catalogAccess.updateMany({
        where: { revokedById: id },
        data: { revokedById: null },
      }),
      // Clear portal-admission actor references
      prisma.portalAdmission.updateMany({
        where: { admittedById: id },
        data: { admittedById: null },
      }),
      prisma.portalAdmission.updateMany({
        where: { claimedById: id },
        data: { claimedById: null },
      }),
      prisma.portalAdmission.updateMany({
        where: { revokedById: id },
        data: { revokedById: null },
      }),
      // Clear pending-catalog-grant actor references
      prisma.pendingCatalogGrant.updateMany({
        where: { grantedById: id },
        data: { grantedById: null },
      }),
      prisma.pendingCatalogGrant.updateMany({
        where: { consumedById: id },
        data: { consumedById: null },
      }),
      prisma.pendingCatalogGrant.updateMany({
        where: { revokedById: id },
        data: { revokedById: null },
      }),
      // Delete the user (cascades Account, CatalogAccess)
      prisma.user.delete({ where: { id } }),
    ]);

    // Audit log user deletion (captured email before deletion)
    await logUserLifecycleEvent({
      actorId: currentUserId!,
      action: "USER_DELETED",
      targetUserId: id,
      targetEmail: targetUser.email,
      details: { email: targetUser.email },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "user", "delete");
  }
}

/**
 * PATCH /api/admin/users/:id - Update user status
 * Body: { status?: UserStatus }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId: currentUserId } = await requireAdminCapability({
      message: "Unauthorized",
    });

    const paramsResult = validateParams(await params, UserIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, UpdateUserSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { status, name } = bodyResult.data;

    // Get current user
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isSuperadmin: true, status: true, email: true },
    });

    if (!targetUser) {
      return notFound("user");
    }

    // Prevent modifying superadmin status unless you're a superadmin
    if (targetUser.isSuperadmin) {
      const currentIsSuperadmin = await isSuperadmin();
      if (!currentIsSuperadmin) {
        return forbidden("Cannot modify superadmin users");
      }
    }

    // Prevent self-blocking
    if (currentUserId === id && status === "BLOCKED") {
      return badRequest("Cannot block yourself");
    }

    const updateData: { status?: UserStatus; activatedAt?: Date; name?: string } = {};

    if (status) {
      updateData.status = status as UserStatus;

      // Set activatedAt when activating
      if (status === "ACTIVE" && targetUser.status !== "ACTIVE") {
        updateData.activatedAt = new Date();
      }
    }

    if (name !== undefined) {
      updateData.name = name;
    }

    // If blocking user, delete all their sessions to force immediate logout
    if (status === "BLOCKED" && targetUser.status !== "BLOCKED") {
      await prisma.session.deleteMany({ where: { userId: id } });
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        status: true,
        isSuperadmin: true,
        isAdmin: true,
        lastLoginAt: true,
        createdAt: true,
        activatedAt: true,
      },
    });

    // Audit log user status changes
    if (status && status !== targetUser.status) {
      const previousStatus = targetUser.status;
      if (status === "ACTIVE") {
        await logUserEvent("USER_ACTIVATED", currentUserId!, id, {
          previousStatus,
          email: targetUser.email,
        });
      } else if (status === "BLOCKED") {
        await logUserEvent("USER_BLOCKED", currentUserId!, id, {
          previousStatus,
          email: targetUser.email,
        });
      } else if (previousStatus === "BLOCKED") {
        await logUserEvent("USER_UNBLOCKED", currentUserId!, id, {
          previousStatus,
          newStatus: status,
          email: targetUser.email,
        });
      }
    }

    return NextResponse.json(user);
  } catch (error) {
    return handlePrismaError(error, "user", "update");
  }
}
