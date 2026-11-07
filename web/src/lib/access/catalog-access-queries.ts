import prisma from "@/lib/db";
import { getConfiguredArchive } from "@/lib/archive";
import {
  hasSystemCatalogAuthority,
  type PortalActorContext,
} from "@/lib/policy/actor";

type CatalogAccessEntry = {
  catalogId: string;
};

export async function listUserCatalogAccessEntries(
  actor: PortalActorContext
): Promise<CatalogAccessEntry[]> {
  if (!actor.userId || !actor.canEnterPortal) {
    return [];
  }

  const archive = await getConfiguredArchive();

  if (hasSystemCatalogAuthority(actor)) {
    const allCatalogs = await prisma.workflowGroup.findMany({
      where: { isActive: true, ...(archive ? { id: archive.id } : {}) },
      select: { id: true },
    });

    return allCatalogs.map((catalog) => ({
      catalogId: catalog.id,
    }));
  }

  return prisma.catalogAccess.findMany({
    where: {
      userId: actor.userId,
      status: "ACTIVE",
      ...(archive ? { catalogId: archive.id } : {}),
    },
    select: {
      catalogId: true,
    },
  });
}
