import prisma from "@/lib/db";
import { getSession } from "./session";
import { resolvePortalActorContext } from "@/lib/policy/actor";

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

// ============================================================================
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
