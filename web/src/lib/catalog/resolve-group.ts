import prisma from "@/lib/db";
import { getAdminCapability, getCatalogCapability } from "@/lib/access/capabilities";
import { ArchiveScopeError, assertArchiveCatalogId } from "@/lib/archive";

// Use Prisma's inference for the return type
type WorkflowGroup = NonNullable<
  Awaited<ReturnType<typeof prisma.workflowGroup.findFirst>>
>;

/**
 * Load the active catalog a route names in its path (`/api/catalogs/:id/...`).
 *
 * Returns null for foreign, missing or inactive catalogs. Callers answer
 * "not found" for null and check access themselves, so a catalog within the
 * archive scope that the user cannot open gets a proper "access denied".
 */
export async function findActiveCatalog(catalogId: string): Promise<WorkflowGroup | null> {
  try {
    await assertArchiveCatalogId(catalogId);
  } catch (error) {
    if (error instanceof ArchiveScopeError) return null;
    throw error;
  }
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
 * Within the deployment's archive scope, admins have implicit access; everyone
 * else needs a catalog grant.
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
