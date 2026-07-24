import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { resolveCatalogManagementActor } from "@/lib/access/catalog-management-route-access";
import {
  canAttemptCatalogManagement,
  canManageExistingCatalogAccessLevel,
} from "@/lib/policy/catalog";
import { TimestampIdParamSchema, UserSearchQuerySchema } from "@/lib/validation/schemas";
import { validateParams, validateSearchParams, forbidden, notFound, handlePrismaError } from "@/lib/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

    const queryResult = validateSearchParams(request.nextUrl.searchParams, UserSearchQuerySchema);
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
      return forbidden("OWNER or Admin access required to manage catalog access");
    }

    // If no search query, return empty results
    if (!search || search.trim().length < 2) {
      return NextResponse.json({
        users: [],
        canInvite: false,
      });
    }

    const searchTerm = search.trim().toLowerCase();
    const canManageOwnerAccess = canManageExistingCatalogAccessLevel(
      access.policyContext,
      "OWNER"
    );

    // Get users with ACTIVE access to this catalog (for update option)
    const activeAccess = await prisma.catalogAccess.findMany({
      where: {
        catalogId,
        status: "ACTIVE",
        ...(canManageOwnerAccess ? {} : { accessLevel: { not: "OWNER" } }),
        OR: [
          { user: { email: { contains: searchTerm, mode: "insensitive" } } },
          { user: { name: { contains: searchTerm, mode: "insensitive" } } },
        ],
      },
      select: {
        accessLevel: true,
        notes: true,
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      take: 5,
    });

    // Get users with REVOKED access to this catalog (for restore option)
    const revokedAccess = await prisma.catalogAccess.findMany({
      where: {
        catalogId,
        status: "REVOKED",
        ...(canManageOwnerAccess ? {} : { accessLevel: { not: "OWNER" } }),
        OR: [
          { user: { email: { contains: searchTerm, mode: "insensitive" } } },
          { user: { name: { contains: searchTerm, mode: "insensitive" } } },
        ],
      },
      select: {
        accessLevel: true,
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      take: 5,
    });

    // Get users who DON'T have any access (ACTIVE or REVOKED) to this catalog
    const availableUsers = await prisma.user.findMany({
      where: {
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
    });

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
        currentAccessLevel: access.accessLevel,
        notes: access.notes,
      })),
      // Revoked users next (for restore)
      ...revokedAccess.map((access) => ({
        id: access.user.id,
        name: access.user.name,
        email: access.user.email,
        image: access.user.image,
        type: "revoked" as const,
        previousAccessLevel: access.accessLevel,
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
