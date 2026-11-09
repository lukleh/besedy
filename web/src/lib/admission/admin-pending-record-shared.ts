import prisma from "@/lib/db";
import { requireArchive, type ArchiveBinding } from "@/lib/archive";
import {
  serializePendingAdminAdmission,
  type PendingAdmissionRecord,
  type PendingInvitationGrant,
} from "@/lib/admission/admin-read-models";

export async function loadPendingAdmissionState(canonicalEmail: string) {
  const archive = await requireArchive();
  const [admission, grant] = await Promise.all([
    prisma.portalAdmission.findFirst({
      where: { email: canonicalEmail, status: "PENDING" },
      select: {
        email: true,
        admittedAt: true,
        admittedById: true,
        notes: true,
      },
    }),
    prisma.pendingCatalogGrant.findUnique({
      where: {
        email_catalogId: { email: canonicalEmail, catalogId: archive.id },
        status: "PENDING",
      },
      select: {
        catalogId: true,
        role: true,
        extraPermissions: true,
        notes: true,
        grantedById: true,
        grantedAt: true,
      },
    }),
  ]);
  return { admission, grant, archive };
}

export async function buildPendingAdmissionPresentation(
  admission: PendingAdmissionRecord,
  grant: PendingInvitationGrant | null,
  archive: ArchiveBinding,
) {
  const actorIds = [
    ...new Set(
      [admission.admittedById, grant?.grantedById].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({
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
  return serializePendingAdminAdmission(admission, grant, archive, actorById);
}
