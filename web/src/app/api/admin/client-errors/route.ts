import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AuthError } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse end date for range queries.
 * - Date-only (YYYY-MM-DD): shifts to next day 00:00 UTC, use exclusive (lt)
 * - Full timestamp: keeps as-is, use inclusive (lte)
 */
function parseDateEnd(value: string | null): { date: Date; exclusive: boolean } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // If it's date-only (YYYY-MM-DD), shift to next day 00:00 for exclusive end
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCDate(date.getUTCDate() + 1);
    date.setUTCHours(0, 0, 0, 0);
    return { date, exclusive: true };
  }
  return { date, exclusive: false };
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * GET /api/admin/client-errors - Query client-side error reports
 *
 * Query params:
 * - userId: Filter by user ID
 * - source: Filter by source
 * - digest: Filter by digest
 * - message: Filter by message substring
 * - url: Filter by URL substring
 * - from: Start date (ISO)
 * - to: End date (ISO)
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Admin access required" });

    const { searchParams } = new URL(request.url);
    const filterUserId = searchParams.get("userId");
    const sourceFilter = searchParams.get("source");
    const digestFilter = searchParams.get("digest");
    const messageFilter = searchParams.get("message");
    const urlFilter = searchParams.get("url");
    const fromDate = parseDate(searchParams.get("from"));
    const toDateResult = parseDateEnd(searchParams.get("to"));
    const page = parsePositiveInt(searchParams.get("page"), 1);
    const limit = Math.min(100, parsePositiveInt(searchParams.get("limit"), 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (filterUserId) {
      where.userId = filterUserId;
    }

    if (sourceFilter) {
      where.source = sourceFilter;
    }

    if (digestFilter) {
      where.digest = digestFilter;
    }

    if (messageFilter) {
      where.message = { contains: messageFilter, mode: "insensitive" };
    }

    if (urlFilter) {
      where.url = { contains: urlFilter, mode: "insensitive" };
    }

    if (fromDate || toDateResult) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = fromDate;
      }
      if (toDateResult) {
        if (toDateResult.exclusive) {
          where.createdAt.lt = toDateResult.date;
        } else {
          where.createdAt.lte = toDateResult.date;
        }
      }
    }

    const total = await prisma.clientErrorReport.count({ where });

    const reports = await prisma.clientErrorReport.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });

    return NextResponse.json({
      reports,
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
    return handlePrismaError(error, "client error reports", "fetch");
  }
}
