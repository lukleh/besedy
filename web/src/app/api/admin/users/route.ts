import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { UserStatus, AccessLevel } from "@/generated/prisma/client";
import { UserListQuerySchema } from "@/lib/validation/schemas";
import { validateSearchParams, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";

// Access level hierarchy (higher index = higher privilege)
const ACCESS_LEVEL_ORDER: AccessLevel[] = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"];

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users - List real portal users
 * Query params: ?status=PENDING|ACTIVE|BLOCKED&search=email
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const queryResult = validateSearchParams(request.nextUrl.searchParams, UserListQuerySchema);
    if (!queryResult.success) return queryResult.response;
    const { status, search } = queryResult.data;

    const where: {
      status?: UserStatus;
      OR?: Array<{ email?: { contains: string; mode: "insensitive" }; name?: { contains: string; mode: "insensitive" } }>;
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
            accessLevel: true,
            catalog: {
              select: { id: true, label: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Calculate highest access level and extract catalog names for each user
    const usersWithCatalogInfo = users.map((user) => {
      let highestAccessLevel: AccessLevel | null = null;
      const catalogNames: string[] = [];

      if (user.catalogAccess.length > 0) {
        let highestIndex = -1;
        for (const access of user.catalogAccess) {
          // Track highest access level
          const index = ACCESS_LEVEL_ORDER.indexOf(access.accessLevel);
          if (index > highestIndex) {
            highestIndex = index;
            highestAccessLevel = access.accessLevel;
          }
          // Collect catalog names
          catalogNames.push(access.catalog.label || access.catalog.id);
        }
      }

      // Return user without the full catalogAccess array
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { catalogAccess: _omitted, ...userWithoutAccess } = user;
      return {
        ...userWithoutAccess,
        type: "user" as const,
        highestAccessLevel,
        catalogNames,
      };
    });

    return NextResponse.json(usersWithCatalogInfo);
  } catch (error) {
    return handlePrismaError(error, "users", "fetch");
  }
}
