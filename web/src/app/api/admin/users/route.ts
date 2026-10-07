import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { UserStatus } from "@/generated/prisma/client";
import { UserListQuerySchema } from "@/lib/validation/schemas";
import { validateSearchParams, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

interface UserActivityRow {
  id: string;
  last_played_at: Date | null;
  last_activity_at: Date | null;
}

/**
 * Last played is the latest playback progress save: the player saves every
 * few seconds while a recording plays, and offline listening saves when it
 * syncs. Last activity also counts audited actions (user_id is always the
 * actor), MCP tool calls, and the last sign-in. GREATEST ignores NULLs.
 */
async function getUserActivity(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, UserActivityRow>();
  const rows = await prisma.$queryRaw<UserActivityRow[]>`
    SELECT
      s.id,
      s.last_played_at,
      GREATEST(
        s.last_played_at,
        s.last_login_at,
        s.last_audit_at,
        s.last_mcp_at,
        s.last_mcp_daily_at
      ) AS last_activity_at
    FROM (
      SELECT
        u.id,
        u.last_login_at,
        (SELECT max(p.updated_at) FROM recording_playback_progress p
          WHERE p.user_id = u.id) AS last_played_at,
        (SELECT max(a.created_at) FROM audit_log a
          WHERE a.user_id = u.id) AS last_audit_at,
        (SELECT max(m.created_at) FROM mcp_tool_invocation m
          WHERE m.user_id = u.id) AS last_mcp_at,
        (SELECT max(d.last_used_at) FROM mcp_tool_usage_daily d
          WHERE d.actor_user_id = u.id) AS last_mcp_daily_at
      FROM users u
      WHERE u.id = ANY(${userIds})
    ) s
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * GET /api/admin/users - List real portal users
 * Query params: ?status=PENDING|ACTIVE|BLOCKED&search=email&include=activity
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const queryResult = validateSearchParams(
      request.nextUrl.searchParams,
      UserListQuerySchema
    );
    if (!queryResult.success) return queryResult.response;
    const { status, search, include } = queryResult.data;

    const where: {
      status?: UserStatus;
      OR?: Array<{
        email?: { contains: string; mode: "insensitive" };
        name?: { contains: string; mode: "insensitive" };
      }>;
    } = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
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
        catalogAccess: {
          where: {
            status: "ACTIVE",
          },
          select: {
            role: true,
            catalog: {
              select: { id: true, label: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const activity =
      include === "activity"
        ? await getUserActivity(users.map((user) => user.id))
        : null;

    // Roles are deliberately not ordered. Return the distinct roles rather
    // than inventing a misleading "highest" one.
    const usersWithCatalogInfo = users.map((user) => {
      const catalogNames: string[] = [];
      const catalogRoles = new Set<string>();

      for (const access of user.catalogAccess) {
        catalogRoles.add(access.role);
        catalogNames.push(access.catalog.label || access.catalog.id);
      }

      // Return user without the full catalogAccess array
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { catalogAccess: _omitted, ...userWithoutAccess } = user;
      return {
        ...userWithoutAccess,
        type: "user" as const,
        ...(activity && {
          lastPlayedAt: activity.get(user.id)?.last_played_at ?? null,
          lastActivityAt: activity.get(user.id)?.last_activity_at ?? null,
        }),
        catalogRoles: Array.from(catalogRoles),
        catalogNames,
      };
    });

    return NextResponse.json(usersWithCatalogInfo);
  } catch (error) {
    return handlePrismaError(error, "users", "fetch");
  }
}
