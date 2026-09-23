import type { CatalogRole, PrismaClient } from "../src/generated/prisma/client";
import { canonicalizeEmail } from "../src/lib/email";
import { grantFieldsForRole } from "../src/lib/policy/catalog-permissions";

type SeedPendingAdmissionClient = Pick<PrismaClient, "portalAdmission" | "pendingCatalogGrant">;

export interface SeedPendingAdmissionInput {
  email: string;
  createdById: string | null;
  createdAt: Date;
  catalogId: string | null;
  role: CatalogRole | null;
  extraPermissions?: string[];
  notes: string | null;
}

// Seed scripts write fixture-driven pending admission and grant state directly
// into the canonical tables used by OAuth claim.

function hasCatalogGrant(
  input: SeedPendingAdmissionInput
): input is SeedPendingAdmissionInput & {
  catalogId: string;
  role: CatalogRole;
} {
  return input.catalogId !== null && input.role !== null;
}

export async function syncSeedPendingAdmissions(
  db: SeedPendingAdmissionClient,
  input: SeedPendingAdmissionInput
): Promise<void> {
  const email = canonicalizeEmail(input.email);
  const grantBacked = hasCatalogGrant(input);

  await db.portalAdmission.upsert({
    where: { email },
    create: {
      email,
      source: grantBacked ? "PENDING_GRANT" : "STANDALONE",
      status: "PENDING",
      revocationReason: null,
      admittedById: input.createdById,
      admittedAt: input.createdAt,
      claimedById: null,
      claimedAt: null,
      revokedById: null,
      revokedAt: null,
      notes: input.notes,
    },
    update: {
      source: grantBacked ? "PENDING_GRANT" : "STANDALONE",
      status: "PENDING",
      revocationReason: null,
      admittedById: input.createdById,
      admittedAt: input.createdAt,
      claimedById: null,
      claimedAt: null,
      revokedById: null,
      revokedAt: null,
      notes: input.notes,
    },
  });

  if (grantBacked) {
    await db.pendingCatalogGrant.deleteMany({
      where: {
        email,
        NOT: { catalogId: input.catalogId },
      },
    });

    await db.pendingCatalogGrant.upsert({
      where: {
        email_catalogId: {
          email,
          catalogId: input.catalogId,
        },
      },
      create: {
        email,
        catalogId: input.catalogId,
        ...grantFieldsForRole(input.role, input.extraPermissions ?? []),
        status: "PENDING",
        grantedById: input.createdById,
        grantedAt: input.createdAt,
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: input.notes,
      },
      update: {
        ...grantFieldsForRole(input.role, input.extraPermissions ?? []),
        status: "PENDING",
        grantedById: input.createdById,
        grantedAt: input.createdAt,
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: input.notes,
      },
    });

    return;
  }

  await db.pendingCatalogGrant.deleteMany({
    where: { email },
  });
}
