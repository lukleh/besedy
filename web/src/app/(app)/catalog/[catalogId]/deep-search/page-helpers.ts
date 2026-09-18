import { notFound } from "next/navigation";
import prisma from "@/lib/db";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import {
  canAccessCatalogDeepSearch,
  getLabsPreferenceForUser,
  isFeatureEnabledForUser,
} from "@/lib/features/capabilities";
import { getDeepSearchDefaultInstructions } from "@/lib/config";

export async function requireDeepSearchPageAccess(catalogId: string) {
  const { userId } = await requireCatalogPageAccess(catalogId);
  const [canCreateJobs, labsPreference] = await Promise.all([
    canAccessCatalogDeepSearch(userId, catalogId),
    getLabsPreferenceForUser(userId),
  ]);
  if (!isFeatureEnabledForUser("deep-search", labsPreference.enabled)) {
    notFound();
  }

  const catalog = await prisma.workflowGroup.findUnique({
    where: { id: catalogId },
    select: { id: true, label: true },
  });
  if (!catalog) {
    notFound();
  }

  return {
    userId,
    catalogLabel: catalog.label || catalog.id,
    canCreateJobs,
    deepSearchDefaultInstructions: getDeepSearchDefaultInstructions(),
  };
}
