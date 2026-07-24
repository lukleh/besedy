import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { handlePrismaError } from "@/lib/api";
import { AuditAction } from "@/generated/prisma/enums";
import { countPendingPortalAdmissions } from "@/lib/admission/admin-read-models";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

const LEGACY_AUDIT_RESOURCE = "invitation";

/**
 * GET /api/admin/dashboard/stats - Get comprehensive dashboard statistics
 * Returns user stats, audit log summary, and client error summary
 */
export async function GET() {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    // Calculate date boundaries in UTC
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const [
      // User counts
      userTotal,
      userActive,
      pendingAdmissions,
      userBlocked,

      // Audit: Security events today
      loginsTodaySuccess,
      loginsTodayFailed,
      accessDeniedToday,
      superadminAccessToday,

      // Audit: Security events yesterday (for trends)
      loginsYesterdaySuccess,
      loginsYesterdayFailed,
      accessDeniedYesterday,
      superadminAccessYesterday,

      // Recent activity feed
      recentActivity,

      // Client errors today by source
      clientErrorsTodayBySource,

      // Client errors yesterday by source
      clientErrorsYesterdayBySource,
    ] = await Promise.all([
      // User counts
      prisma.user.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      countPendingPortalAdmissions(),
      prisma.user.count({ where: { status: "BLOCKED" } }),

      // Audit: Security events today
      prisma.auditLog.count({
        where: { action: AuditAction.LOGIN, createdAt: { gte: todayStart } },
      }),
      prisma.auditLog.count({
        where: { action: AuditAction.LOGIN_FAILED, createdAt: { gte: todayStart } },
      }),
      prisma.auditLog.count({
        where: { action: AuditAction.ACCESS_DENIED, createdAt: { gte: todayStart } },
      }),
      prisma.auditLog.count({
        where: { action: AuditAction.SUPERADMIN_ACCESS, createdAt: { gte: todayStart } },
      }),

      // Audit: Security events yesterday
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN,
          createdAt: { gte: yesterdayStart, lt: todayStart },
        },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN_FAILED,
          createdAt: { gte: yesterdayStart, lt: todayStart },
        },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.ACCESS_DENIED,
          createdAt: { gte: yesterdayStart, lt: todayStart },
        },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.SUPERADMIN_ACCESS,
          createdAt: { gte: yesterdayStart, lt: todayStart },
        },
      }),

      // Recent activity feed (last 10)
      prisma.auditLog.findMany({
        where: {
          resource: { not: LEGACY_AUDIT_RESOURCE },
        },
        take: 10,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          action: true,
          resource: true,
          resourceId: true,
          user: {
            select: { name: true, email: true },
          },
        },
      }),

      // Client errors today grouped by source
      prisma.clientErrorReport.groupBy({
        by: ["source"],
        where: { createdAt: { gte: todayStart } },
        _count: true,
      }),

      // Client errors yesterday grouped by source
      prisma.clientErrorReport.groupBy({
        by: ["source"],
        where: { createdAt: { gte: yesterdayStart, lt: todayStart } },
        _count: true,
      }),
    ]);

    // Process client errors into a more useful format
    const errorSources = ["error-boundary", "window.onerror", "window.unhandledrejection"];
    const clientErrorsBySource: Record<string, { today: number; yesterday: number }> = {};

    for (const source of errorSources) {
      const todayEntry = clientErrorsTodayBySource.find((e) => e.source === source);
      const yesterdayEntry = clientErrorsYesterdayBySource.find((e) => e.source === source);
      clientErrorsBySource[source] = {
        today: todayEntry?._count ?? 0,
        yesterday: yesterdayEntry?._count ?? 0,
      };
    }

    // Also add any unknown sources that appeared
    for (const entry of clientErrorsTodayBySource) {
      if (entry.source && !errorSources.includes(entry.source)) {
        const yesterdayEntry = clientErrorsYesterdayBySource.find((e) => e.source === entry.source);
        clientErrorsBySource[entry.source] = {
          today: entry._count,
          yesterday: yesterdayEntry?._count ?? 0,
        };
      }
    }

    const totalErrorsToday = clientErrorsTodayBySource.reduce((sum, e) => sum + e._count, 0);
    const totalErrorsYesterday = clientErrorsYesterdayBySource.reduce((sum, e) => sum + e._count, 0);

    return NextResponse.json({
      users: {
        total: userTotal,
        active: userActive,
      pending: pendingAdmissions,
        blocked: userBlocked,
      },
      audit: {
        loginsTodaySuccess,
        loginsTodayFailed,
        accessDeniedToday,
        superadminAccessToday,
        loginsYesterdaySuccess,
        loginsYesterdayFailed,
        accessDeniedYesterday,
        superadminAccessYesterday,
        recentActivity: recentActivity.map((log) => ({
          id: log.id,
          createdAt: log.createdAt.toISOString(),
          action: log.action,
          resource: log.resource,
          resourceId: log.resourceId,
          user: log.user,
        })),
      },
      clientErrors: {
        totalToday: totalErrorsToday,
        totalYesterday: totalErrorsYesterday,
        bySource: clientErrorsBySource,
      },
    });
  } catch (error) {
    return handlePrismaError(error, "dashboard stats", "fetch");
  }
}
