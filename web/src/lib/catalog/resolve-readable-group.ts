import prisma from "@/lib/db";
import { getCatalogDiscoveryCapability } from "@/lib/access/capabilities";

type WorkflowGroup = NonNullable<
  Awaited<ReturnType<typeof prisma.workflowGroup.findFirst>>
>;

export type ReadableGroupResolutionSource =
  "explicit" | "preference" | "default" | "recent";

export interface ReadableGroupResolution {
  group: WorkflowGroup;
  source: ReadableGroupResolutionSource;
}

/**
 * Resolve an active, accessible catalog for a read-only service call.
 *
 * Unlike resolveActiveGroup(), this function has no preference-writing side
 * effects and never returns an inaccessible catalog. It is intended for MCP
 * and other non-navigation application services.
 */
export async function resolveReadableGroup(
  catalogId: string | null | undefined,
  userId: string
): Promise<ReadableGroupResolution | null> {
  const discovery = await getCatalogDiscoveryCapability(userId);
  if (
    !discovery.canEnterPortal ||
    discovery.accessibleCatalogIds.length === 0
  ) {
    return null;
  }

  const accessibleCatalogIds = new Set(discovery.accessibleCatalogIds);
  if (catalogId && !accessibleCatalogIds.has(catalogId)) {
    return null;
  }

  const [preferences, groups] = await Promise.all([
    prisma.userPreferences.findUnique({
      where: { userId },
      select: { activeGroupId: true },
    }),
    prisma.workflowGroup.findMany({
      where: {
        id: { in: discovery.accessibleCatalogIds },
        isActive: true,
      },
      orderBy: { id: "desc" },
    }),
  ]);

  const byId = new Map(groups.map((group) => [group.id, group]));

  if (catalogId) {
    const explicitGroup = byId.get(catalogId);
    return explicitGroup ? { group: explicitGroup, source: "explicit" } : null;
  }

  if (preferences?.activeGroupId) {
    const preferredGroup = byId.get(preferences.activeGroupId);
    if (preferredGroup) {
      return { group: preferredGroup, source: "preference" };
    }
  }

  const defaultGroup = groups.find((group) => group.isDefault);
  if (defaultGroup) {
    return { group: defaultGroup, source: "default" };
  }

  const recentGroup = groups[0];
  return recentGroup ? { group: recentGroup, source: "recent" } : null;
}
