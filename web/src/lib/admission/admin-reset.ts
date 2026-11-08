import type { PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireArchive } from "@/lib/archive";
import { canonicalizeEmail } from "@/lib/email";

type AdmissionResetClient = Pick<
  PrismaClient,
  "$transaction" | "portalAdmission" | "pendingCatalogGrant" | "user"
>;

export interface PortalAdmissionResetResult {
  portalAdmissionId: string;
  email: string;
  pendingGrantCount: number;
  reopenedGrants: Array<{
    catalogId: string;
    role: string;
  }>;
}

export class PortalAdmissionNotFoundError extends Error {
  constructor(email: string) {
    super(`No portal admission found for ${email}`);
    this.name = "PortalAdmissionNotFoundError";
  }
}

export class PortalAdmissionNotClaimedError extends Error {
  constructor(email: string) {
    super(`Portal admission for ${email} is not in CLAIMED state`);
    this.name = "PortalAdmissionNotClaimedError";
  }
}

export class PortalAdmissionUserStillExistsError extends Error {
  constructor(email: string) {
    super(`Portal admission for ${email} still belongs to an existing user`);
    this.name = "PortalAdmissionUserStillExistsError";
  }
}

export class PortalAdmissionMissingContentAccessError extends Error {
  constructor(email: string) {
    super(`Portal admission for ${email} has no saved active content access`);
    this.name = "PortalAdmissionMissingContentAccessError";
  }
}

export async function resetClaimedPortalAdmission(
  email: string,
  actorId: string,
  db: AdmissionResetClient = prisma
): Promise<PortalAdmissionResetResult> {
  const archive = await requireArchive();
  const canonicalEmail = canonicalizeEmail(email);

  return db.$transaction(async (tx) => {
    const admission = await tx.portalAdmission.findUnique({
      where: { email: canonicalEmail },
      select: {
        id: true,
        email: true,
        status: true,
        admittedById: true,
        admittedAt: true,
        notes: true,
      },
    });

    if (!admission) {
      throw new PortalAdmissionNotFoundError(canonicalEmail);
    }

    if (admission.status !== "CLAIMED") {
      throw new PortalAdmissionNotClaimedError(canonicalEmail);
    }

    const existingUser = await tx.user.findUnique({
      where: { email: canonicalEmail },
      select: { id: true },
    });

    if (existingUser) {
      throw new PortalAdmissionUserStillExistsError(canonicalEmail);
    }

    const consumedGrant = await tx.pendingCatalogGrant.findUnique({
      where: {
        email_catalogId: { email: canonicalEmail, catalogId: archive.id },
        status: "CONSUMED",
      },
      select: { catalogId: true, role: true },
    });
    if (!consumedGrant)
      throw new PortalAdmissionMissingContentAccessError(canonicalEmail);

    const reopened = await tx.portalAdmission.updateMany({
      where: { email: canonicalEmail, status: "CLAIMED" },
      data: {
        status: "PENDING",
        claimedById: null,
        claimedAt: null,
        revocationReason: null,
        revokedById: null,
        revokedAt: null,
      },
    });

    if (reopened.count !== 1)
      throw new PortalAdmissionNotClaimedError(canonicalEmail);
    const grantReopened = await tx.pendingCatalogGrant.updateMany({
      where: {
        email: canonicalEmail,
        catalogId: archive.id,
        status: "CONSUMED",
      },
      data: {
        status: "PENDING",
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
      },
    });

    if (grantReopened.count !== 1)
      throw new PortalAdmissionMissingContentAccessError(canonicalEmail);
    return {
      portalAdmissionId: admission.id,
      email: canonicalEmail,
      pendingGrantCount: 1,
      reopenedGrants: [consumedGrant],
    };
  });
}
