import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AuthError } from "@/lib/auth/permissions";
import { AuditAction } from "@/generated/prisma/enums";
import { handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { mapAuditLogToListItem } from "@/lib/audit/model";

export const dynamic = "force-dynamic";

const LEGACY_AUDIT_RESOURCE = "invitation";

/**
 * GET /api/admin/audit - Query audit logs
 *
 * Query params:
 * - userId: Filter by user ID
 * - action: Filter by action type (comma-separated for multiple)
 * - resource: Filter by resource type
 * - from: Start date (ISO format)
 * - to: End date (ISO format)
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 *
 * Admins can see all logs and filter by user.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Admin access required" });

    const { searchParams } = new URL(request.url);
    const filterUserId = searchParams.get("userId");
    const actionFilter = searchParams.get("action");
    const resourceFilter = searchParams.get("resource");
    const domainFilter = searchParams.get("domain");
    const subjectTypeFilter = searchParams.get("subjectType");
    const outcomeFilter = searchParams.get("outcome");
    const fromDate = searchParams.get("from");
    const toDate = searchParams.get("to");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
    // Support offset-based pagination for load-more pattern
    const offset = searchParams.has("offset")
      ? Math.max(0, parseInt(searchParams.get("offset") || "0", 10))
      : null;

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    // Filter by user if specified
    if (filterUserId) {
      where.userId = filterUserId;
    }

    // Action filter
    if (actionFilter) {
      const actions = actionFilter.split(",").filter((a) =>
        Object.values(AuditAction).includes(a as AuditAction)
      );
      if (actions.length === 1) {
        where.action = actions[0];
      } else if (actions.length > 1) {
        where.action = { in: actions };
      }
    }

    where.AND = [
      { resource: { not: LEGACY_AUDIT_RESOURCE } },
      { domain: { not: null } },
    ];

    // Resource filter
    if (resourceFilter) {
      where.AND.push({ resource: resourceFilter });
    }

    if (domainFilter) {
      where.domain = domainFilter;
    }

    if (subjectTypeFilter) {
      where.subjectType = subjectTypeFilter;
    }

    if (outcomeFilter) {
      where.outcome = outcomeFilter;
    }

    // Date range filter
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = new Date(fromDate);
      }
      if (toDate) {
        where.createdAt.lte = new Date(toDate);
      }
    }

    const canonicalFilterWhere = {
      AND: [
        { resource: { not: LEGACY_AUDIT_RESOURCE } },
        { domain: { not: null } },
      ],
    };

    const [total, distinctResources, distinctDomains, distinctSubjectTypes, distinctOutcomes, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where: canonicalFilterWhere,
        select: { resource: true },
        distinct: ["resource"],
        orderBy: { resource: "asc" },
      }),
      prisma.auditLog.findMany({
        where: canonicalFilterWhere,
        select: { domain: true },
        distinct: ["domain"],
        orderBy: { domain: "asc" },
      }),
      prisma.auditLog.findMany({
        where: canonicalFilterWhere,
        select: { subjectType: true },
        distinct: ["subjectType"],
        orderBy: { subjectType: "asc" },
      }),
      prisma.auditLog.findMany({
        where: canonicalFilterWhere,
        select: { outcome: true },
        distinct: ["outcome"],
        orderBy: { outcome: "asc" },
      }),
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: offset !== null ? offset : (page - 1) * limit,
        take: limit,
      }),
    ]);

    const resources = distinctResources.map((r) => r.resource);
    const domains = distinctDomains
      .map((entry) => entry.domain)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const subjectTypes = distinctSubjectTypes
      .map((entry) => entry.subjectType)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const outcomes = distinctOutcomes
      .map((entry) => entry.outcome)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return NextResponse.json({
      logs: logs.map(mapAuditLogToListItem),
      resources,
      filters: {
        domains,
        subjectTypes,
        outcomes,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return handlePrismaError(error, "audit logs", "fetch");
  }
}
