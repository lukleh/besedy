import type { AccessLevel, UserStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";

export type SystemRole = "USER" | "ADMIN" | "SUPERADMIN";

export interface PortalActorContext {
  userId: string | null;
  isAuthenticated: boolean;
  userStatus: UserStatus | null;
  systemRole: SystemRole;
  canEnterPortal: boolean;
}

export interface CatalogActorContext extends PortalActorContext {
  catalogId: string;
  catalogExists: boolean;
  catalogGrant: AccessLevel | null;
  hasCatalogAccess: boolean;
  isCatalogOwner: boolean;
  isCatalogAdmin: boolean;
}

export function hasSystemCatalogAuthority(
  actor: Pick<PortalActorContext, "systemRole">
): boolean {
  return actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN";
}

interface ResolveCatalogActorContextOptions {
  activeCatalogOnly?: boolean;
}

async function resolveUserId(userId?: string): Promise<string | null> {
  if (userId !== undefined) {
    return userId;
  }

  // Service callers such as MCP always provide a verified user ID. Load the
  // request/session stack only for browser-facing callers that need it, so a
  // reusable policy import does not initialize Better Auth as a side effect.
  const { getCurrentUserId } = await import("@/lib/auth/session");
  return getCurrentUserId();
}

export async function resolvePortalActorContext(
  userId?: string
): Promise<PortalActorContext> {
  const resolvedUserId = await resolveUserId(userId);
  if (!resolvedUserId) {
    return {
      userId: null,
      isAuthenticated: false,
      userStatus: null,
      systemRole: "USER",
      canEnterPortal: false,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: resolvedUserId },
    select: {
      status: true,
      isAdmin: true,
      isSuperadmin: true,
    },
  });
  if (!user || user.status !== "ACTIVE") {
    return {
      userId: resolvedUserId,
      isAuthenticated: true,
      userStatus: user?.status ?? null,
      systemRole: "USER",
      canEnterPortal: false,
    };
  }

  return {
    userId: resolvedUserId,
    isAuthenticated: true,
    userStatus: user.status,
    systemRole: user.isSuperadmin ? "SUPERADMIN" : user.isAdmin ? "ADMIN" : "USER",
    canEnterPortal: true,
  };
}

export async function resolveCatalogActorContext(
  catalogId: string,
  userId?: string,
  options: ResolveCatalogActorContextOptions = {}
): Promise<CatalogActorContext> {
  const [portal, catalog] = await Promise.all([
    resolvePortalActorContext(userId),
    prisma.workflowGroup.findFirst({
      where: {
        id: catalogId,
        ...(options.activeCatalogOnly === false ? {} : { isActive: true }),
      },
      select: { id: true },
    }),
  ]);
  const catalogExists = !!catalog;

  if (!catalogExists || !portal.userId || !portal.canEnterPortal) {
    return {
      ...portal,
      catalogId,
      catalogExists,
      catalogGrant: null,
      hasCatalogAccess: false,
      isCatalogOwner: false,
      isCatalogAdmin: false,
    };
  }

  const isCatalogAdmin = hasSystemCatalogAuthority(portal);

  const access = isCatalogAdmin
    ? null
    : await prisma.catalogAccess.findUnique({
        where: {
          userId_catalogId: {
            userId: portal.userId,
            catalogId,
          },
        },
        select: {
          accessLevel: true,
          status: true,
        },
      });

  const catalogGrant = access?.status === "ACTIVE" ? access.accessLevel : null;

  return {
    ...portal,
    catalogId,
    catalogExists,
    catalogGrant,
    hasCatalogAccess: isCatalogAdmin || catalogGrant !== null,
    isCatalogOwner: catalogGrant === "OWNER",
    isCatalogAdmin,
  };
}
