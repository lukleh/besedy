import prisma from "@/lib/db";
import { getAdminCapability, getCatalogCapability } from "@/lib/access/capabilities";

// Use Prisma's inference for the return type
type WorkflowGroup = NonNullable<
  Awaited<ReturnType<typeof prisma.workflowGroup.findFirst>>
>;

/**
 * Load the active catalog a route names in its path (`/api/catalogs/:id/...`).
 *
 * Returns null when the catalog does not exist or is inactive. It does not check
 * access: callers answer "not found" for null and check access themselves, so a
 * catalog the user cannot open gets a proper "access denied".
 */
export async function findActiveCatalog(catalogId: string): Promise<WorkflowGroup | null> {
  return prisma.workflowGroup.findFirst({
    where: { id: catalogId, isActive: true },
  });
}

export interface ResolvedGroupAccess {
  group: WorkflowGroup | null;
  hasAccess: boolean;
}

/**
 * Load the catalog a route names and evaluate whether the user can access it.
 *
 * Admins have implicit access to every catalog; everyone else needs a catalog
 * grant.
 */
export async function resolveCatalogWithAccess(
  catalogId: string,
  userId: string
): Promise<ResolvedGroupAccess> {
  const group = await findActiveCatalog(catalogId);
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
