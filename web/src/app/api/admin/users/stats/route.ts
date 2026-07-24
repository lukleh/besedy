import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { handlePrismaError } from "@/lib/api";
import { countPendingPortalAdmissions } from "@/lib/admission/admin-read-models";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users/stats - Get user statistics
 */
export async function GET() {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const [total, active, pending, blocked] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      countPendingPortalAdmissions(),
      prisma.user.count({ where: { status: "BLOCKED" } }),
    ]);

    return NextResponse.json({
      total,
      active,
      pending,
      blocked,
    });
  } catch (error) {
    return handlePrismaError(error, "user stats", "fetch");
  }
}
