import type { CatalogRole, PrismaClient } from "../src/generated/prisma/client";
import { canonicalizeEmail } from "../src/lib/email";
import { grantFieldsForRole } from "../src/lib/policy/catalog-permissions";

type SeedPendingAdmissionClient = Pick<
  PrismaClient,
  "portalAdmission" | "pendingCatalogGrant"
>;

export interface SeedPendingAdmissionInput {
  email: string;
  createdById: string | null;
  createdAt: Date;
  catalogId: string;
  role: CatalogRole;
  extraPermissions?: string[];
  notes: string | null;
}

// Seed scripts write fixture-driven pending admission and grant state directly
// into the canonical tables used by OAuth claim.

export async function syncSeedPendingAdmissions(
  db: SeedPendingAdmissionClient,
  input: SeedPendingAdmissionInput,
): Promise<void> {
  if (!input.catalogId || !input.role) {
    throw new Error("Seed invitations require a catalog and role");
  }
  const email = canonicalizeEmail(input.email);

  await db.portalAdmission.upsert({
    where: { email },
    create: {
      email,
      source: "PENDING_GRANT",
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
      source: "PENDING_GRANT",
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
}
