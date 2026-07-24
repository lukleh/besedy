import prisma from "@/lib/db";
import { getSession } from "./session";
import { AccessLevel } from "@/generated/prisma/client";
import {
  hasEditorAuthorityOnAnyCatalog,
  listUserCatalogAccessEntries,
} from "@/lib/access/catalog-access-queries";
import { accessLevelAtLeast } from "@/lib/policy/access-level";
import {
  resolveCatalogActorContext,
  resolvePortalActorContext,
} from "@/lib/policy/actor";

/**
 * Permission types for catalog access
 */
export const Permission = {
  // System level
  SUPERADMIN: "SUPERADMIN",
  MANAGE_USERS: "MANAGE_USERS",
  MANAGE_CATALOGS: "MANAGE_CATALOGS",
  // Catalog level (derived from AccessLevel)
  VIEW: "VIEW",
  STREAM: "STREAM",
  VIEW_TRANSCRIPTS: "VIEW_TRANSCRIPTS", // View transcript text (VIEWER+)
  COMMENT: "COMMENT",
  DOWNLOAD: "DOWNLOAD",
  EDIT_METADATA: "EDIT_METADATA",
  MANAGE_ACCESS: "MANAGE_ACCESS", // Admin-only access management
  MANAGE_PENDING_ACCESS: "MANAGE_PENDING_ACCESS", // Pending admission/grant management
} as const;

export type PermissionType = (typeof Permission)[keyof typeof Permission];
export { accessLevelAtLeast };

/**
 * Permissions granted by each access level (cumulative)
 * Hierarchy: LISTENER < VIEWER < MEMBER < EDITOR < OWNER
 */
const ACCESS_PERMISSIONS: Record<AccessLevel, PermissionType[]> = {
  LISTENER: [Permission.VIEW, Permission.STREAM],
  VIEWER: [Permission.VIEW, Permission.STREAM, Permission.VIEW_TRANSCRIPTS],
  MEMBER: [
    Permission.VIEW,
    Permission.STREAM,
    Permission.VIEW_TRANSCRIPTS,
    Permission.COMMENT,
    Permission.DOWNLOAD,
  ],
  EDITOR: [
    Permission.VIEW,
    Permission.STREAM,
    Permission.VIEW_TRANSCRIPTS,
    Permission.COMMENT,
    Permission.DOWNLOAD,
    Permission.EDIT_METADATA,
  ],
  OWNER: [
    Permission.VIEW,
    Permission.STREAM,
    Permission.VIEW_TRANSCRIPTS,
    Permission.COMMENT,
    Permission.DOWNLOAD,
    Permission.EDIT_METADATA,
    Permission.MANAGE_ACCESS,
    Permission.MANAGE_PENDING_ACCESS,
  ],
};

// ============================================================================
// User Identity
// ============================================================================

/**
 * Get the current user's ID from session
 */
export async function getCurrentUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

/**
 * Get the current user with their status and admin flags
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session?.user?.id) return null;

  return prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      isSuperadmin: true,
      isAdmin: true,
    },
  });
}

// ============================================================================
// Superadmin Checks
// ============================================================================

/**
 * Check if the current user is a superadmin
 */
export async function isSuperadmin(): Promise<boolean> {
  const actor = await resolvePortalActorContext();
  return actor.systemRole === "SUPERADMIN";
}

/**
 * Check if a specific user is a superadmin
 */
export async function isUserSuperadmin(userId: string): Promise<boolean> {
  const actor = await resolvePortalActorContext(userId);
  return actor.systemRole === "SUPERADMIN";
}

// ============================================================================
// Admin Checks (Layer 1)
// ============================================================================

/**
 * Check if the current user is an admin (can manage users and catalogs)
 */
export async function isAdmin(userId?: string): Promise<boolean> {
  const actor = await resolvePortalActorContext(userId);
  return actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN";
}

/**
 * Check if the current user can access admin routes.
 * Requires: superadmin OR isAdmin
 */
export async function canAccessAdmin(): Promise<boolean> {
  const actor = await resolvePortalActorContext();
  return actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN";
}

/**
 * Check if user can manage pending portal admissions
 * Allowed: SUPERADMIN or ADMIN
 */
export async function canManagePortalAdmissions(
  userId?: string
): Promise<boolean> {
  return isAdmin(userId);
}

/**
 * Check if user has EDITOR access on ANY catalog (for enum management)
 * This is a global permission - not tied to a specific catalog.
 * Used for managing Recorder and Location enumerations.
 */
export async function hasEditorOnAnyCatalog(userId?: string): Promise<boolean> {
  const actor = await resolvePortalActorContext(userId);
  return hasEditorAuthorityOnAnyCatalog(actor);
}

/**
 * Require EDITOR access on any catalog - throws if not authorized
 * Used for enum management routes
 */
export async function requireEditorOnAnyCatalog(): Promise<string> {
  const userId = await requireAuth();

  const hasAccess = await hasEditorOnAnyCatalog(userId);
  if (!hasAccess) {
    throw new AuthError("EDITOR access on at least one catalog required", 403);
  }

  return userId;
}

// ============================================================================
// Catalog Access (Layer 2)
// ============================================================================

/**
 * Get user's access level for a specific catalog.
 *
 * Note: BLOCKED users return null even if they have CatalogAccess records.
 * CatalogAccess records are intentionally retained when blocking users to
 * allow easy restoration of access when unblocking. The status check here
 * provides runtime access denial.
 */
export async function getCatalogAccess(
  userId: string,
  catalogId: string
): Promise<AccessLevel | null> {
  const actor = await resolveCatalogActorContext(catalogId, userId);
  if (!actor.catalogExists || !actor.canEnterPortal) {
    return null;
  }

  return actor.isCatalogAdmin ? "OWNER" : actor.catalogGrant;
}

/**
 * Check if user has at least the required access level for a catalog
 */
export async function canAccessCatalog(
  userId: string,
  catalogId: string,
  requiredLevel: AccessLevel = "VIEWER"
): Promise<boolean> {
  const level = await getCatalogAccess(userId, catalogId);
  if (!level) return false;

  return accessLevelAtLeast(level, requiredLevel);
}

/**
 * Get all catalogs a user has access to with their access levels.
 *
 * Note: Returns empty array for BLOCKED/PENDING users even if they have
 * CatalogAccess records. Records are retained to allow easy restoration
 * when unblocking.
 */
export async function getUserCatalogAccess(userId: string): Promise<
  Array<{
    catalogId: string;
    accessLevel: AccessLevel;
  }>
> {
  const actor = await resolvePortalActorContext(userId);
  return listUserCatalogAccessEntries(actor);
}

/**
 * Get permissions for a specific catalog based on access level
 */
export function getPermissionsForAccessLevel(
  level: AccessLevel
): Set<PermissionType> {
  return new Set(ACCESS_PERMISSIONS[level]);
}

/**
 * Check if user has a specific permission for a catalog
 */
export async function hasCatalogPermission(
  userId: string,
  catalogId: string,
  permission: PermissionType
): Promise<boolean> {
  const level = await getCatalogAccess(userId, catalogId);
  if (!level) return false;

  const permissions = getPermissionsForAccessLevel(level);
  return permissions.has(permission);
}

// ============================================================================
// Permission Checks (Current User)
// ============================================================================

/**
 * Check if current user has a specific permission for a catalog
 */
export async function hasPermission(
  permission: PermissionType,
  catalogId?: string
): Promise<boolean> {
  const userId = await getCurrentUserId();
  if (!userId) return false;

  // System-level permissions
  if (permission === Permission.SUPERADMIN) {
    return isSuperadmin();
  }
  if (permission === Permission.MANAGE_USERS || permission === Permission.MANAGE_CATALOGS) {
    return isAdmin(userId);
  }

  // Catalog-level permissions require a catalog ID
  if (!catalogId) {
    // Check if user has this permission for ANY catalog
    const access = await getUserCatalogAccess(userId);
    return access.some((a) => {
      const permissions = getPermissionsForAccessLevel(a.accessLevel);
      return permissions.has(permission);
    });
  }

  return hasCatalogPermission(userId, catalogId, permission);
}

// ============================================================================
// Authorization Helpers
// ============================================================================

/**
 * Result of permission check
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  userId?: string;
}

/**
 * Require authentication - throws if not authenticated
 */
export async function requireAuth(): Promise<string> {
  const userId = await getCurrentUserId();
  if (!userId) {
    throw new AuthError("Authentication required", 401);
  }

  return userId;
}

/**
 * Require admin access - throws if not authorized
 */
export async function requireAdmin(): Promise<string> {
  const userId = await requireAuth();

  const hasAccess = await canAccessAdmin();
  if (!hasAccess) {
    throw new AuthError("Admin access required", 403);
  }

  return userId;
}

/**
 * Require specific catalog access level - throws if not authorized
 */
export async function requireCatalogAccess(
  catalogId: string,
  requiredLevel: AccessLevel = "VIEWER"
): Promise<string> {
  const userId = await requireAuth();

  const hasAccess = await canAccessCatalog(userId, catalogId, requiredLevel);
  if (!hasAccess) {
    throw new AuthError(
      `Catalog access required: ${requiredLevel} or higher`,
      403
    );
  }

  return userId;
}

/**
 * Require portal-admission management permission - throws if not authorized
 */
export async function requirePortalAdmissionManagement(): Promise<string> {
  const userId = await requireAuth();

  const canManage = await canManagePortalAdmissions(userId);
  if (!canManage) {
    throw new AuthError("Permission to manage portal admissions required", 403);
  }

  return userId;
}

/**
 * Require a specific permission - throws if not authorized
 */
export async function requirePermission(
  permission: PermissionType,
  catalogId?: string
): Promise<string> {
  const userId = await requireAuth();

  const hasPerm = await hasPermission(permission, catalogId);
  if (!hasPerm) {
    throw new AuthError(`Permission required: ${permission}`, 403);
  }

  return userId;
}

/**
 * Custom error class for auth errors
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 403
  ) {
    super(message);
    this.name = "AuthError";
  }
}
