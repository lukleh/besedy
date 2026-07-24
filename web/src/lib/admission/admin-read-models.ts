import type { PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";

type AdmissionReadClient = Pick<
  PrismaClient,
  "portalAdmission" | "pendingCatalogGrant" | "user" | "workflowGroup"
>;

export interface PendingAdminAdmissionItem {
  id: string;
  email: string;
  status: "PENDING";
  invitedAt: string;
  pendingGrants: PendingAdminAdmissionGrant[];
  catalogNames: string[];
  pendingGrantCount: number;
  catalogId: string | null;
  catalogLabel: string | null;
  accessLevel:
    | "LISTENER"
    | "VIEWER"
    | "MEMBER"
    | "EDITOR"
    | "OWNER"
    | null;
  invitedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

export interface PendingAdminAdmissionGrant {
  catalogId: string;
  catalogLabel: string;
  accessLevel:
    | "LISTENER"
    | "VIEWER"
    | "MEMBER"
    | "EDITOR"
    | "OWNER";
  grantedAt: string;
  grantedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

function uniqueNonNullStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string"))
  );
}

const ACCESS_LEVEL_ORDER = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"] as const;

function highestPendingAccessLevel(
  grants: Array<{ accessLevel: PendingAdminAdmissionItem["accessLevel"] }>
): PendingAdminAdmissionItem["accessLevel"] {
  let highestIndex = -1;
  let highestLevel: PendingAdminAdmissionItem["accessLevel"] = null;

  for (const grant of grants) {
    if (!grant.accessLevel) {
      continue;
    }

    const index = ACCESS_LEVEL_ORDER.indexOf(grant.accessLevel);
    if (index > highestIndex) {
      highestIndex = index;
      highestLevel = grant.accessLevel;
    }
  }

  return highestLevel;
}

export async function listPendingAdminAdmissions(
  search?: string,
  db: AdmissionReadClient = prisma
): Promise<PendingAdminAdmissionItem[]> {
  const where = {
    status: "PENDING" as const,
    ...(search
      ? {
          email: {
            contains: search,
            mode: "insensitive" as const,
          },
        }
      : {}),
  };

  const admissions = await db.portalAdmission.findMany({
    where,
    select: {
      id: true,
      email: true,
      admittedAt: true,
      admittedById: true,
      notes: true,
    },
    orderBy: { admittedAt: "desc" },
  });

  const emails = admissions.map((admission) => admission.email);
  const pendingGrants = emails.length > 0
    ? await db.pendingCatalogGrant.findMany({
        where: {
          status: "PENDING",
          email: { in: emails },
        },
        select: {
          email: true,
          catalogId: true,
          accessLevel: true,
          notes: true,
          grantedAt: true,
          grantedById: true,
        },
        orderBy: [{ grantedAt: "desc" }, { catalogId: "asc" }],
      })
    : [];

  // Admin pending-state stays admission-centric for now. When multiple grants
  // exist for one email, we summarize them alongside the single
  // portal-admission row instead of pretending one arbitrary grant is the
  // whole pending state.
  const pendingGrantsByEmail = new Map<string, Array<(typeof pendingGrants)[number]>>();
  for (const pendingGrant of pendingGrants) {
    const grantsForEmail = pendingGrantsByEmail.get(pendingGrant.email) ?? [];
    grantsForEmail.push(pendingGrant);
    pendingGrantsByEmail.set(pendingGrant.email, grantsForEmail);
  }

  const catalogIds = uniqueNonNullStrings(
    Array.from(pendingGrantsByEmail.values()).flatMap((grants) =>
      grants.map((grant) => grant.catalogId)
    )
  );
  const actorIds = uniqueNonNullStrings([
    ...admissions.map((admission) => admission.admittedById),
    ...Array.from(pendingGrantsByEmail.values()).flatMap((grants) =>
      grants.map((grant) => grant.grantedById)
    ),
  ]);

  const [catalogs, actors] = await Promise.all([
    catalogIds.length > 0
      ? db.workflowGroup.findMany({
          where: { id: { in: catalogIds } },
          select: { id: true, label: true },
        })
      : Promise.resolve([]),
    actorIds.length > 0
      ? db.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
  ]);

  const actorById = new Map(
    actors.map((actor) => [
      actor.id,
      actor.email
        ? {
            id: actor.id,
            name: actor.name,
            email: actor.email,
          }
        : null,
    ])
  );
  const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));

  return admissions.map((admission) => {
    const pendingGrantsForEmail = pendingGrantsByEmail.get(admission.email) ?? [];
    const newestPendingGrant = pendingGrantsForEmail[0] ?? null;
    const pendingGrantCount = pendingGrantsForEmail.length;
    const singleCatalogGrant = pendingGrantCount === 1 ? newestPendingGrant : null;
    const pendingGrants = pendingGrantsForEmail.map((grant) => {
      const catalog = catalogById.get(grant.catalogId);
      return {
        catalogId: grant.catalogId,
        catalogLabel: catalog?.label || grant.catalogId,
        accessLevel: grant.accessLevel,
        grantedAt: grant.grantedAt.toISOString(),
        grantedBy: grant.grantedById ? actorById.get(grant.grantedById) ?? null : null,
        notes: grant.notes ?? null,
      };
    });
    const catalogNames = pendingGrants.map((grant) => grant.catalogLabel);
    const invitedBy =
      (admission.admittedById ? actorById.get(admission.admittedById) ?? null : null) ??
      (newestPendingGrant?.grantedById
        ? actorById.get(newestPendingGrant.grantedById) ?? null
        : null);
    const catalog = singleCatalogGrant
      ? catalogById.get(singleCatalogGrant.catalogId)
      : null;

    return {
      id: admission.email,
      email: admission.email,
      status: "PENDING",
      invitedAt: admission.admittedAt.toISOString(),
      pendingGrants,
      catalogNames,
      pendingGrantCount,
      catalogId: singleCatalogGrant?.catalogId ?? null,
      catalogLabel: catalog?.label || singleCatalogGrant?.catalogId || null,
      accessLevel: highestPendingAccessLevel(pendingGrantsForEmail),
      invitedBy,
      notes: admission.notes ?? newestPendingGrant?.notes ?? null,
    };
  });
}

export async function countPendingPortalAdmissions(
  db: AdmissionReadClient = prisma
): Promise<number> {
  return db.portalAdmission.count({
    where: { status: "PENDING" },
  });
}
