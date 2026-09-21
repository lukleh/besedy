import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  canAttemptCatalogManagement,
  canManageExistingCatalogGrant,
} from "@/lib/policy/catalog";
import {
  TimestampIdParamSchema,
  UserSearchQuerySchema,
} from "@/lib/validation/schemas";
import {
  validateParams,
  validateSearchParams,
  forbidden,
  notFound,
  handlePrismaError,
} from "@/lib/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const ACCESS_SEARCH_RESULT_LIMIT = 5;
const ACCESS_SEARCH_PAGE_SIZE = 50;
const ACCESS_SEARCH_MAX_PAGES = 10;

/**
 * GET /api/catalogs/:id/users?search=query - Search users for access grant dialog
 * Returns:
 * - Users with ACTIVE access to this catalog (can update)
 * - Users without ACTIVE access to this catalog (available to grant)
 * - Users with REVOKED access to this catalog (can restore)
 * - Whether the search looks like an invitable email
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const queryResult = validateSearchParams(
      request.nextUrl.searchParams,
      UserSearchQuerySchema
    );
    if (!queryResult.success) return queryResult.response;
    const { search } = queryResult.data;

    // Check if catalog exists
    const catalog = await prisma.workflowGroup.findUnique({
      where: { id: catalogId },
      select: { id: true },
    });

    if (!catalog) {
      return notFound("catalog");
    }

    // Check permissions
    const access = await resolveCatalogManagementActor(catalogId, {
      userId,
      activeCatalogOnly: false,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!canAttemptCatalogManagement(access.policyContext)) {
      return forbidden("Catalog access-management permission required");
    }

    // If no search query, return empty results
    if (!search || search.trim().length < 2) {
      return NextResponse.json({
        users: [],
        canInvite: false,
      });
    }

    const searchTerm = search.trim().toLowerCase();
    const findManageableAccess = async (status: "ACTIVE" | "REVOKED") => {
      const matches = [];
      let cursor: string | undefined;

      // The policy predicate cannot be expressed safely as a role list. Scan
      // bounded pages until five actionable grants are found instead of
      // loading every textual match into memory on each keystroke.
      for (
        let page = 0;
        page < ACCESS_SEARCH_MAX_PAGES &&
        matches.length < ACCESS_SEARCH_RESULT_LIMIT;
        page += 1
      ) {
        const candidates = await prisma.catalogAccess.findMany({
          where: {
            catalogId,
            status,
            userId: { not: userId },
            OR: [
              {
                user: {
                  email: { contains: searchTerm, mode: "insensitive" },
                },
              },
              {
                user: {
                  name: { contains: searchTerm, mode: "insensitive" },
                },
              },
            ],
          },
          select: {
            id: true,
            role: true,
            extraPermissions: true,
            notes: true,
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
          },
          orderBy: { id: "asc" },
          take: ACCESS_SEARCH_PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        for (const grant of candidates) {
          if (
            canManageExistingCatalogGrant(access.policyContext, {
              role: grant.role,
              extras: grant.extraPermissions,
            })
          ) {
            matches.push(grant);
            if (matches.length === ACCESS_SEARCH_RESULT_LIMIT) break;
          }
        }

        if (candidates.length < ACCESS_SEARCH_PAGE_SIZE) break;
        cursor = candidates.at(-1)?.id;
        if (!cursor) break;
      }

      return matches;
    };

    const [activeAccess, revokedAccess, availableUsers] = await Promise.all([
      findManageableAccess("ACTIVE"),
      findManageableAccess("REVOKED"),
      // Get users who DON'T have any access (ACTIVE or REVOKED) to this catalog.
      prisma.user.findMany({
        where: {
          id: { not: userId },
          status: { not: "BLOCKED" },
          OR: [
            { email: { contains: searchTerm, mode: "insensitive" } },
            { name: { contains: searchTerm, mode: "insensitive" } },
          ],
          // Exclude users who already have access (ACTIVE or REVOKED)
          catalogAccess: {
            none: { catalogId },
          },
        },
        select: { id: true, name: true, email: true, image: true },
        take: 10,
      }),
    ]);

    // Check if search looks like a valid email for a new pending admission
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(searchTerm);
    let canInvite = false;
    let inviteEmail: string | undefined;

    if (isEmail) {
      // Check if this email already exists in the system
      const existingUser = await prisma.user.findFirst({
        where: { email: { equals: searchTerm, mode: "insensitive" } },
        select: { id: true },
      });

      if (!existingUser) {
        canInvite = true;
        inviteEmail = searchTerm;
      }
    }

    // Format response
    const users = [
      // Active users first (for update)
      ...activeAccess.map((access) => ({
        id: access.user.id,
        name: access.user.name,
        email: access.user.email,
        image: access.user.image,
        type: "active" as const,
        currentRole: access.role,
        extraPermissions: access.extraPermissions ?? [],
        notes: access.notes,
      })),
      // Revoked users next (for restore)
      ...revokedAccess.map((access) => ({
        id: access.user.id,
        name: access.user.name,
        email: access.user.email,
        image: access.user.image,
        type: "revoked" as const,
        previousRole: access.role,
        extraPermissions: access.extraPermissions ?? [],
      })),
      // Available users last (no current access)
      ...availableUsers.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        type: "available" as const,
      })),
    ];

    return NextResponse.json({
      users,
      canInvite,
      inviteEmail,
    });
  } catch (error) {
    return handlePrismaError(error, "user search", "fetch");
  }
}
