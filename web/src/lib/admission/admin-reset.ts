import type { PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
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
    accessLevel: string;
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

export async function resetClaimedPortalAdmission(
  email: string,
  actorId: string,
  db: AdmissionResetClient = prisma
): Promise<PortalAdmissionResetResult> {
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

    const consumedGrants = await tx.pendingCatalogGrant.findMany({
      where: {
        email: canonicalEmail,
        status: "CONSUMED",
      },
      select: {
        catalogId: true,
        accessLevel: true,
        grantedById: true,
        grantedAt: true,
        notes: true,
      },
      orderBy: [{ grantedAt: "asc" }, { catalogId: "asc" }],
    });

    await tx.portalAdmission.update({
      where: { email: canonicalEmail },
      data: {
        status: "PENDING",
        claimedById: null,
        claimedAt: null,
        revocationReason: null,
        revokedById: null,
        revokedAt: null,
      },
    });

    if (consumedGrants.length > 0) {
      await tx.pendingCatalogGrant.updateMany({
        where: {
          email: canonicalEmail,
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
    }

    return {
      portalAdmissionId: admission.id,
      email: canonicalEmail,
      pendingGrantCount: consumedGrants.length,
      reopenedGrants: consumedGrants.map((grant) => ({
        catalogId: grant.catalogId,
        accessLevel: grant.accessLevel,
      })),
    };
  });
}
