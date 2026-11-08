import type { CatalogRole, PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireArchive } from "@/lib/archive";

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
  role: CatalogRole | null;
  invitedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

export interface PendingAdminAdmissionGrant {
  catalogId: string;
  catalogLabel: string;
  role: CatalogRole;
  extraPermissions: string[];
  grantedAt: string;
  grantedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

function uniqueNonNullStrings(
  values: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === "string")
    )
  );
}

export async function listPendingAdminAdmissions(
  search?: string,
  db: AdmissionReadClient = prisma
): Promise<PendingAdminAdmissionItem[]> {
  const archive = await requireArchive();
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
  const pendingGrants =
    emails.length > 0
      ? await db.pendingCatalogGrant.findMany({
          where: {
            status: "PENDING",
            catalogId: archive.id,
            email: { in: emails },
          },
          select: {
            email: true,
            catalogId: true,
            role: true,
            extraPermissions: true,
            notes: true,
            grantedAt: true,
            grantedById: true,
          },
        })
      : [];

  // The composite email/source key leaves at most one live bound grant.
  // Other source rows remain available to historical audit readers.
  const pendingGrantByEmail = new Map(
    pendingGrants.map((grant) => [grant.email, grant])
  );

  const catalogIds = uniqueNonNullStrings(
    pendingGrants.map((grant) => grant.catalogId)
  );
  const actorIds = uniqueNonNullStrings([
    ...admissions.map((admission) => admission.admittedById),
    ...pendingGrants.map((grant) => grant.grantedById),
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
    const singleCatalogGrant = pendingGrantByEmail.get(admission.email) ?? null;
    const pendingGrantsForEmail = singleCatalogGrant
      ? [singleCatalogGrant]
      : [];
    const pendingGrantCount = pendingGrantsForEmail.length;
    const pendingGrants = pendingGrantsForEmail.map((grant) => {
      const catalog = catalogById.get(grant.catalogId);
      return {
        catalogId: grant.catalogId,
        catalogLabel: catalog?.label || grant.catalogId,
        role: grant.role,
        extraPermissions: grant.extraPermissions ?? [],
        grantedAt: grant.grantedAt.toISOString(),
        grantedBy: grant.grantedById
          ? (actorById.get(grant.grantedById) ?? null)
          : null,
        notes: grant.notes ?? null,
      };
    });
    const catalogNames = pendingGrants.map((grant) => grant.catalogLabel);
    let invitedBy: PendingAdminAdmissionItem["invitedBy"] = null;
    if (admission.admittedById) {
      invitedBy = actorById.get(admission.admittedById) ?? null;
    }
    if (!invitedBy && singleCatalogGrant?.grantedById) {
      invitedBy = actorById.get(singleCatalogGrant.grantedById) ?? null;
    }
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
      role: singleCatalogGrant?.role ?? null,
      invitedBy,
      notes: admission.notes ?? singleCatalogGrant?.notes ?? null,
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
