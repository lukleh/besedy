import type {
  CatalogRole,
  PendingCatalogGrant,
  PortalAdmission,
  PrismaClient,
} from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireArchive, type ArchiveBinding } from "@/lib/archive";

type AdmissionReadClient = Pick<
  PrismaClient,
  "portalAdmission" | "pendingCatalogGrant" | "user"
>;

export interface PendingAdminAdmissionItem {
  id: string;
  email: string;
  status: "PENDING";
  invitedAt: string;
  catalogId: string | null;
  catalogLabel: string | null;
  role: CatalogRole | null;
  extraPermissions: string[];
  invitedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

export type PendingAdmissionRecord = Pick<
  PortalAdmission,
  "email" | "admittedAt" | "admittedById" | "notes"
>;
export type PendingInvitationGrant = Pick<
  PendingCatalogGrant,
  | "catalogId"
  | "role"
  | "extraPermissions"
  | "grantedAt"
  | "grantedById"
  | "notes"
>;
type AdmissionActor = NonNullable<PendingAdminAdmissionItem["invitedBy"]>;

export function serializePendingAdminAdmission(
  admission: PendingAdmissionRecord,
  grant: PendingInvitationGrant | null,
  archive: ArchiveBinding,
  actors: ReadonlyMap<string, AdmissionActor>,
): PendingAdminAdmissionItem {
  return {
    id: admission.email,
    email: admission.email,
    status: "PENDING",
    invitedAt: admission.admittedAt.toISOString(),
    catalogId: grant?.catalogId ?? null,
    catalogLabel: grant ? archive.label || archive.id : null,
    role: grant?.role ?? null,
    extraPermissions: grant?.extraPermissions ?? [],
    invitedBy:
      actors.get(admission.admittedById ?? "") ??
      actors.get(grant?.grantedById ?? "") ??
      null,
    notes: admission.notes ?? grant?.notes ?? null,
  };
}

export async function listPendingAdminAdmissions(
  search?: string,
  db: AdmissionReadClient = prisma,
): Promise<PendingAdminAdmissionItem[]> {
  const archive = await requireArchive();
  const admissions = await db.portalAdmission.findMany({
    where: {
      status: "PENDING",
      ...(search
        ? { email: { contains: search, mode: "insensitive" as const } }
        : {}),
    },
    select: { email: true, admittedAt: true, admittedById: true, notes: true },
    orderBy: { admittedAt: "desc" },
  });
  const emails = admissions.map((admission) => admission.email);
  const grants = emails.length
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
  const grantByEmail = new Map(grants.map((grant) => [grant.email, grant]));
  const actorIds = [
    ...new Set(
      [
        ...admissions.map((admission) => admission.admittedById),
        ...grants.map((grant) => grant.grantedById),
      ].filter((id): id is string => !!id),
    ),
  ];
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const actorById = new Map(
    actors.flatMap((actor) =>
      actor.email
        ? [[actor.id, { ...actor, email: actor.email }] as const]
        : [],
    ),
  );
  return admissions.map((admission) =>
    serializePendingAdminAdmission(
      admission,
      grantByEmail.get(admission.email) ?? null,
      archive,
      actorById,
    ),
  );
}

export async function countPendingPortalAdmissions(
  db: AdmissionReadClient = prisma,
): Promise<number> {
  return db.portalAdmission.count({ where: { status: "PENDING" } });
}
