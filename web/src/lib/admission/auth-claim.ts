import type { AccessLevel, PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { canonicalizeEmail } from "@/lib/email";

type AdmissionAuthClient = Pick<PrismaClient, "$transaction" | "portalAdmission">;

export interface PendingPortalAdmission {
  id: string;
  admittedById: string | null;
  admittedAt: Date;
  notes: string | null;
}

export interface ConsumedPendingCatalogGrant {
  catalogId: string;
  accessLevel: AccessLevel;
  grantedById: string | null;
  notes: string | null;
}

export interface PortalAdmissionConsumption {
  portalAdmissionId: string;
  admittedById: string | null;
  admittedAt: Date;
  notes: string | null;
  grants: ConsumedPendingCatalogGrant[];
}

export async function findPendingPortalAdmission(
  email: string,
  db: AdmissionAuthClient = prisma
): Promise<PendingPortalAdmission | null> {
  return db.portalAdmission.findFirst({
    where: {
      email: canonicalizeEmail(email),
      status: "PENDING",
    },
    select: {
      id: true,
      admittedById: true,
      admittedAt: true,
      notes: true,
    },
  });
}

export async function consumePortalAdmissionForUser(
  user: { id: string; email?: string | null },
  db: AdmissionAuthClient = prisma
): Promise<PortalAdmissionConsumption | null> {
  if (!user.email) {
    return null;
  }

  const email = canonicalizeEmail(user.email);
  const claimedAt = new Date();

  return db.$transaction(async (tx) => {
    const claim = await tx.portalAdmission.updateMany({
      where: {
        email,
        status: "PENDING",
      },
      data: {
        status: "CLAIMED",
        claimedById: user.id,
        claimedAt,
        revocationReason: null,
        revokedById: null,
        revokedAt: null,
      },
    });

    if (claim.count === 0) {
      return null;
    }

    const admission = await tx.portalAdmission.findUnique({
      where: { email },
      select: {
        id: true,
        admittedById: true,
        admittedAt: true,
        notes: true,
      },
    });

    if (!admission) {
      throw new Error("Portal admission claimed but not found");
    }

    const pendingGrants = await tx.pendingCatalogGrant.findMany({
      where: {
        email,
        status: "PENDING",
      },
      select: {
        catalogId: true,
        accessLevel: true,
        grantedById: true,
        notes: true,
      },
      orderBy: [{ grantedAt: "asc" }, { catalogId: "asc" }],
    });

    await tx.user.updateMany({
      where: {
        id: user.id,
        status: "PENDING",
      },
      data: {
        status: "ACTIVE",
        activatedAt: claimedAt,
      },
    });

    if (pendingGrants.length > 0) {
      await tx.pendingCatalogGrant.updateMany({
        where: {
          email,
          status: "PENDING",
        },
        data: {
          status: "CONSUMED",
          consumedById: user.id,
          consumedAt: claimedAt,
          revokedById: null,
          revokedAt: null,
        },
      });

      await tx.catalogAccess.createMany({
        data: pendingGrants.map((grant) => ({
          userId: user.id,
          catalogId: grant.catalogId,
          accessLevel: grant.accessLevel,
          grantedById: grant.grantedById,
          notes: grant.notes,
        })),
        skipDuplicates: true,
      });
    }

    return {
      portalAdmissionId: admission.id,
      admittedById: admission.admittedById,
      admittedAt: admission.admittedAt,
      notes: admission.notes,
      grants: pendingGrants,
    };
  });
}
