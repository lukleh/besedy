import prisma from "@/lib/db";
import {
  getAdminCapability,
  getCatalogCapability,
  getCatalogDiscoveryCapability,
} from "@/lib/access/capabilities";

// Use Prisma's inference for the return type
type WorkflowGroup = NonNullable<
  Awaited<ReturnType<typeof prisma.workflowGroup.findFirst>>
>;

/**
 * Resolve the active workflow group following the resolution rules:
 * 1. If group override provided, use it (validates access before saving preference)
 * 2. Else use user preference active_group
 * 3. Else use default group
 * 4. Else use most recent accessible group
 * 5. Fallback for admins/superadmins: Most recent group (they have implicit access)
 * 6. Return null if no accessible group found
 *
 * Note: This function returns the resolved group but downstream routes must still
 * check access permissions. The group override is returned even without access,
 * allowing proper "access denied" messages rather than silent fallback.
 *
 * @param groupOverride - Optional group ID from query param
 * @param userId - Current user ID (null for unauthenticated requests)
 * @returns The resolved WorkflowGroup or null if none found/accessible
 */
export async function resolveActiveGroup(
  groupOverride?: string | null,
  userId?: string | null
): Promise<WorkflowGroup | null> {
  const effectiveUserId = userId || "local";

  // 1. Group override - validate access before saving preference
  if (groupOverride) {
    const group = await prisma.workflowGroup.findFirst({
      where: { id: groupOverride, isActive: true },
    });
    if (group) {
      // Only save preference if user has access to the group
      // Admins have implicit access to all catalogs; regular users need explicit access
      let hasAccess = false;

      if (userId) {
        const [adminCapability, catalogCapability] = await Promise.all([
          getAdminCapability(userId),
          getCatalogCapability(group.id, userId),
        ]);
        hasAccess = adminCapability.canAccessAdmin || catalogCapability.hasAccess;
      }

      if (hasAccess) {
        // Update user preference to remember this selection
        await prisma.userPreferences.upsert({
          where: { userId: effectiveUserId },
          update: { activeGroupId: group.id },
          create: {
            userId: effectiveUserId,
            activeGroupId: group.id,
            theme: "system",
            catalogColumns: [],
            settings: {},
          },
        });
      }
      // Return the group regardless (downstream routes will check access)
      // This allows viewing "no access" messages instead of failing silently
      return group;
    }
  }

  // 2. User preference
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId: effectiveUserId },
    include: { activeGroup: true },
  });
  if (prefs?.activeGroup?.isActive) {
    return prefs.activeGroup;
  }

  // 3. Default group
  const defaultGroup = await prisma.workflowGroup.findFirst({
    where: { isDefault: true, isActive: true },
  });
  if (defaultGroup) {
    return defaultGroup;
  }

  // 4. Most recent accessible group (respects user's catalog access)
  const discovery = await getCatalogDiscoveryCapability(userId || undefined);
  const accessibleGroups = discovery.accessibleCatalogIds;
  if (accessibleGroups.length > 0) {
    return prisma.workflowGroup.findFirst({
      where: { id: { in: accessibleGroups }, isActive: true },
      orderBy: { id: "desc" },
    });
  }

  // 5. Fallback: Only for admins/superadmins (who have implicit access to all catalogs)
  // Regular users with no catalog access should get null, not a random group
  if (userId) {
    const adminCapability = await getAdminCapability(userId);
    if (!adminCapability.canAccessAdmin) {
      return null;
    }

    return prisma.workflowGroup.findFirst({
      where: { isActive: true },
      orderBy: { id: "desc" },
    });
  }

  // No accessible group found for this user
  return null;
}

export interface ResolvedGroupAccess {
  group: WorkflowGroup | null;
  hasAccess: boolean;
}

/**
 * Resolve active group and evaluate whether the user can access it.
 *
 * This keeps resolveActiveGroup behavior intact (it may return an inaccessible
 * group for downstream "403" handling) while giving callers a consistent
 * explicit access check result.
 */
export async function resolveActiveGroupWithAccess(
  groupOverride: string | null | undefined,
  userId: string
): Promise<ResolvedGroupAccess> {
  const group = await resolveActiveGroup(groupOverride, userId);
  if (!group) {
    return { group: null, hasAccess: false };
  }

  const [adminCapability, catalogCapability] = await Promise.all([
    getAdminCapability(userId),
    getCatalogCapability(group.id, userId),
  ]);

  return {
    group,
    hasAccess: adminCapability.canAccessAdmin || catalogCapability.hasAccess,
  };
}
