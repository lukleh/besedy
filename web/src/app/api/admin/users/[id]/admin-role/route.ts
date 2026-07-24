import { NextRequest, NextResponse } from "next/server";
import { isSuperadmin, requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { logAdminRoleEvent } from "@/lib/audit/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isAuthError(error: unknown): error is { message: string; statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number" &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/**
 * PUT /api/admin/users/:id/admin-role - Grant or update admin status
 * Body: { isAdmin: boolean }
 * Only SUPERADMINs can manage admin status
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const currentUserId = await requireAuth();
    // Only superadmins can manage admin status
    const currentIsSuperadmin = await isSuperadmin();
    if (!currentIsSuperadmin) {
      return NextResponse.json(
        { error: "Only superadmins can manage admin status" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = await request.json();
    const { isAdmin } = body;

    // Validate request body
    if (typeof isAdmin !== "boolean") {
      return NextResponse.json(
        { error: "isAdmin must be a boolean" },
        { status: 400 }
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isSuperadmin: true, isAdmin: true, email: true },
    });

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Cannot modify superadmin's admin status
    if (targetUser.isSuperadmin) {
      return NextResponse.json(
        { error: "Cannot modify admin status for superadmin users" },
        { status: 400 }
      );
    }

    // Prevent modifying own admin status
    if (currentUserId === id) {
      return NextResponse.json(
        { error: "Cannot modify your own admin status" },
        { status: 400 }
      );
    }

    // Update user's isAdmin flag
    const user = await prisma.user.update({
      where: { id },
      data: { isAdmin },
      select: {
        id: true,
        isAdmin: true,
      },
    });

    // Audit log admin role change
    if (isAdmin !== targetUser.isAdmin) {
      await logAdminRoleEvent({
        actorId: currentUserId!,
        action: isAdmin ? "ADMIN_ROLE_GRANTED" : "ADMIN_ROLE_REVOKED",
        targetUserId: id,
        targetEmail: targetUser.email,
        details: { email: targetUser.email },
      });
    }

    return NextResponse.json(user);
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error updating admin status:", error);
    return NextResponse.json(
      { error: "Failed to update admin status" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/users/:id/admin-role - Remove admin status
 * Only SUPERADMINs can manage admin status
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const currentUserId = await requireAuth();
    // Only superadmins can manage admin status
    const currentIsSuperadmin = await isSuperadmin();
    if (!currentIsSuperadmin) {
      return NextResponse.json(
        { error: "Only superadmins can manage admin status" },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isSuperadmin: true, isAdmin: true, email: true },
    });

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Cannot modify superadmin's admin status
    if (targetUser.isSuperadmin) {
      return NextResponse.json(
        { error: "Cannot modify admin status for superadmin users" },
        { status: 400 }
      );
    }

    // Prevent removing own admin status
    if (currentUserId === id) {
      return NextResponse.json(
        { error: "Cannot remove your own admin status" },
        { status: 400 }
      );
    }

    // Set isAdmin to false
    await prisma.user.update({
      where: { id },
      data: { isAdmin: false },
    });

    // Audit log admin role revocation (only if they were admin)
    if (targetUser.isAdmin) {
      await logAdminRoleEvent({
        actorId: currentUserId!,
        action: "ADMIN_ROLE_REVOKED",
        targetUserId: id,
        targetEmail: targetUser.email,
        details: { email: targetUser.email },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error removing admin status:", error);
    return NextResponse.json(
      { error: "Failed to remove admin status" },
      { status: 500 }
    );
  }
}
