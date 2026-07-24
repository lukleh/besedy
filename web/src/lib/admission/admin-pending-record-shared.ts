import prisma from "@/lib/db";

// Shared lookup and serialization helpers for the admin pending-record routes.
// Keep route-specific authorization, mutations, and audit decisions in
// admin-pending-record-route.ts.

const ACCESS_LEVEL_ORDER = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"] as const;

type PendingAccessLevel = (typeof ACCESS_LEVEL_ORDER)[number];

export function highestPendingAccessLevel(
  grants: Array<{ accessLevel: PendingAccessLevel }>
): PendingAccessLevel | null {
  let highestIndex = -1;
  let highestLevel: PendingAccessLevel | null = null;

  for (const grant of grants) {
    const index = ACCESS_LEVEL_ORDER.indexOf(grant.accessLevel);
    if (index > highestIndex) {
      highestIndex = index;
      highestLevel = grant.accessLevel;
    }
  }

  return highestLevel;
}

export async function loadPendingAdmissionState(canonicalEmail: string) {
  const [admission, pendingGrants] = await Promise.all([
    prisma.portalAdmission.findFirst({
      where: {
        email: canonicalEmail,
        status: "PENDING",
      },
      select: {
        email: true,
        status: true,
        admittedAt: true,
        admittedById: true,
        notes: true,
      },
    }),
    prisma.pendingCatalogGrant.findMany({
      where: {
        email: canonicalEmail,
        status: "PENDING",
      },
      select: {
        catalogId: true,
        accessLevel: true,
        notes: true,
        grantedById: true,
        grantedAt: true,
      },
      orderBy: [{ grantedAt: "desc" }, { catalogId: "asc" }],
    }),
  ]);

  return { admission, pendingGrants };
}

interface PendingGrantPresentationItem {
  catalogId: string;
  accessLevel: PendingAccessLevel;
  grantedAt: Date;
  grantedById: string | null;
  notes: string | null;
}

export async function buildPendingGrantPresentation(
  pendingGrants: PendingGrantPresentationItem[],
  actorId?: string | null
) {
  const pendingGrantCount = pendingGrants.length;
  const newestPendingGrant = pendingGrants[0] ?? null;
  const singleCatalogGrant = pendingGrantCount === 1 ? newestPendingGrant : null;
  const catalogIds = Array.from(new Set(pendingGrants.map((grant) => grant.catalogId)));
  const actorIds = Array.from(
    new Set(
      [actorId, ...pendingGrants.map((grant) => grant.grantedById)].filter(
        (value): value is string => typeof value === "string"
      )
    )
  );

  const [catalogs, actors, actor] = await Promise.all([
    catalogIds.length > 0
      ? prisma.workflowGroup.findMany({
          where: { id: { in: catalogIds } },
          select: { id: true, label: true },
        })
      : Promise.resolve([]),
    actorIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    actorId
      ? prisma.user.findUnique({
          where: { id: actorId },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve(null),
  ]);

  const actorById = new Map(actors.map((candidate) => [candidate.id, candidate]));
  const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));

  const pendingGrantResponses = pendingGrants.map((grant) => ({
    catalogId: grant.catalogId,
    catalogLabel: catalogById.get(grant.catalogId)?.label || grant.catalogId,
    accessLevel: grant.accessLevel,
    grantedAt: grant.grantedAt.toISOString(),
    grantedBy:
      grant.grantedById
        ? actorById.get(grant.grantedById) ?? null
        : null,
    notes: grant.notes ?? null,
  }));

  return {
    actor,
    catalogNames: pendingGrantResponses.map((grant) => grant.catalogLabel),
    pendingGrantCount,
    pendingGrantResponses,
    singleCatalogGrant,
    singleCatalogLabel:
      singleCatalogGrant
        ? catalogById.get(singleCatalogGrant.catalogId)?.label || singleCatalogGrant.catalogId
        : null,
  };
}
