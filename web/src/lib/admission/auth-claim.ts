import type { CatalogRole, PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireArchive } from "@/lib/archive";
import { canonicalizeEmail } from "@/lib/email";

type AdmissionAuthClient = Pick<
  PrismaClient,
  "$transaction" | "portalAdmission" | "pendingCatalogGrant"
>;

export interface PendingPortalAdmission {
  id: string;
  admittedById: string | null;
  admittedAt: Date;
  notes: string | null;
}

export interface ConsumedPendingCatalogGrant {
  catalogId: string;
  role: CatalogRole;
  extraPermissions: string[];
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

class AdmissionClaimUnavailableError extends Error {}

export async function findPendingPortalAdmission(
  email: string,
  db: AdmissionAuthClient = prisma
): Promise<PendingPortalAdmission | null> {
  const archive = await requireArchive();
  const canonicalEmail = canonicalizeEmail(email);
  const [admission, grant] = await Promise.all([
    db.portalAdmission.findFirst({
      where: { email: canonicalEmail, status: "PENDING" },
      select: { id: true, admittedById: true, admittedAt: true, notes: true },
    }),
    db.pendingCatalogGrant.findUnique({
      where: {
        email_catalogId: { email: canonicalEmail, catalogId: archive.id },
      },
      select: { status: true },
    }),
  ]);
  return grant?.status === "PENDING" ? admission : null;
}

export async function consumePortalAdmissionForUser(
  user: { id: string; email?: string | null },
  db: AdmissionAuthClient = prisma
): Promise<PortalAdmissionConsumption | null> {
  if (!user.email) return null;
  const archive = await requireArchive();
  const email = canonicalizeEmail(user.email);
  const claimedAt = new Date();

  try {
    return await db.$transaction(async (tx) => {
      // All invitation transitions lock the admission before its bound grant.
      const claim = await tx.portalAdmission.updateMany({
        where: { email, status: "PENDING" },
        data: {
          status: "CLAIMED",
          claimedById: user.id,
          claimedAt,
          revocationReason: null,
          revokedById: null,
          revokedAt: null,
        },
      });
      if (claim.count === 0) return null;

      const admission = await tx.portalAdmission.findUnique({
        where: { email },
        select: { id: true, admittedById: true, admittedAt: true, notes: true },
      });
      const grant = await tx.pendingCatalogGrant.findUnique({
        where: {
          email_catalogId: { email, catalogId: archive.id },
          status: "PENDING",
        },
        select: {
          catalogId: true,
          role: true,
          extraPermissions: true,
          grantedById: true,
          notes: true,
        },
      });
      if (!admission || !grant) throw new AdmissionClaimUnavailableError();

      const consumed = await tx.pendingCatalogGrant.updateMany({
        where: { email, catalogId: archive.id, status: "PENDING" },
        data: {
          status: "CONSUMED",
          consumedById: user.id,
          consumedAt: claimedAt,
          revokedById: null,
          revokedAt: null,
        },
      });
      const activated = await tx.user.updateMany({
        where: { id: user.id, status: "PENDING" },
        data: { status: "ACTIVE", activatedAt: claimedAt },
      });
      if (consumed.count !== 1 || activated.count !== 1) {
        // Throw, rather than return, so admission/grant changes roll back too.
        throw new AdmissionClaimUnavailableError();
      }

      await tx.catalogAccess.create({
        data: { userId: user.id, ...grant },
      });
      return {
        portalAdmissionId: admission.id,
        admittedById: admission.admittedById,
        admittedAt: admission.admittedAt,
        notes: admission.notes,
        grants: [grant],
      };
    });
  } catch (error) {
    if (error instanceof AdmissionClaimUnavailableError) return null;
    throw error;
  }
}
