import type { AccessLevel } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import {
  hasSystemCatalogAuthority,
  type PortalActorContext,
} from "@/lib/policy/actor";

type CatalogAccessEntry = {
  catalogId: string;
  accessLevel: AccessLevel;
};

export async function hasEditorAuthorityOnAnyCatalog(
  actor: PortalActorContext
): Promise<boolean> {
  if (!actor.userId || !actor.canEnterPortal) {
    return false;
  }

  if (hasSystemCatalogAuthority(actor)) {
    return true;
  }

  const editorAccess = await prisma.catalogAccess.findFirst({
    where: {
      userId: actor.userId,
      status: "ACTIVE",
      accessLevel: { in: ["EDITOR", "OWNER"] },
    },
    select: { userId: true },
  });

  return editorAccess !== null;
}

export async function listUserCatalogAccessEntries(
  actor: PortalActorContext
): Promise<CatalogAccessEntry[]> {
  if (!actor.userId || !actor.canEnterPortal) {
    return [];
  }

  if (hasSystemCatalogAuthority(actor)) {
    const allCatalogs = await prisma.workflowGroup.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    return allCatalogs.map((catalog) => ({
      catalogId: catalog.id,
      accessLevel: "OWNER" as AccessLevel,
    }));
  }

  return prisma.catalogAccess.findMany({
    where: {
      userId: actor.userId,
      status: "ACTIVE",
    },
    select: {
      catalogId: true,
      accessLevel: true,
    },
  });
}
