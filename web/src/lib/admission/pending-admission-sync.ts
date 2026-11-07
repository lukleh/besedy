import type {
  CatalogRole,
  PendingCatalogGrant,
  PortalAdmissionRevocationReason,
  PrismaClient,
} from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { ArchiveScopeError, requireArchive } from "@/lib/archive";
import { canonicalizeEmail } from "@/lib/email";
import { grantFieldsForRole } from "@/lib/policy/catalog-permissions";

type PendingAdmissionSyncClient = Pick<
  PrismaClient,
  "portalAdmission" | "pendingCatalogGrant"
>;

export interface PendingAdmissionStateInput {
  email: string;
  catalogId: string | null;
  role: CatalogRole | null;
  extraPermissions: string[];
  createdById: string | null;
  createdAt: Date;
  notes: string | null;
}

type ExpectedPendingGrant = Pick<
  PendingCatalogGrant,
  "role" | "extraPermissions" | "status"
>;

interface SyncPendingAdmissionStateOptions {
  allowAdminDeniedReopen?: boolean;
  requirePending?: boolean;
  expectedGrant?: ExpectedPendingGrant | null;
}

interface RevokePendingAdmissionStateOptions {
  actorId: string;
  reason: PortalAdmissionRevocationReason;
  expectedGrant?: ExpectedPendingGrant;
}

export class AdminDeniedAdmissionReopenError extends Error {
  constructor(email: string) {
    super(`Only administrators can reopen admin-denied admission for ${email}`);
    this.name = "AdminDeniedAdmissionReopenError";
  }
}

export class PendingAdmissionUnavailableError extends Error {
  constructor() {
    super("Pending invitation changed. Reload before editing or revoking it.");
    this.name = "PendingAdmissionUnavailableError";
  }
}

// Call inside the caller's transaction so admission and grant change together.
export async function syncPendingAdmissionState(
  input: PendingAdmissionStateInput,
  options: SyncPendingAdmissionStateOptions = {},
  db: PendingAdmissionSyncClient = prisma
) {
  const archive = await requireArchive();
  if (input.catalogId !== archive.id) throw new ArchiveScopeError();
  if (!input.role) throw new PendingAdmissionUnavailableError();
  const email = canonicalizeEmail(input.email);
  const existingAdmission = await db.portalAdmission.findUnique({
    where: { email },
    select: { status: true, revocationReason: true },
  });
  if (options.requirePending && existingAdmission?.status !== "PENDING") {
    throw new PendingAdmissionUnavailableError();
  }
  if (
    existingAdmission?.status === "REVOKED" &&
    existingAdmission.revocationReason === "ADMIN_DENIED" &&
    !options.allowAdminDeniedReopen
  ) {
    throw new AdminDeniedAdmissionReopenError(input.email);
  }

  if (existingAdmission) {
    const updated = await db.portalAdmission.updateMany({
      where: {
        email,
        status: options.requirePending
          ? "PENDING"
          : { in: ["PENDING", "REVOKED"] },
        ...(!options.allowAdminDeniedReopen
          ? {
              OR: [
                { revocationReason: null },
                { revocationReason: { not: "ADMIN_DENIED" as const } },
              ],
            }
          : {}),
      },
      // Preserve original admission identity, source and attribution.
      data: {
        status: "PENDING",
        revocationReason: null,
        revokedById: null,
        revokedAt: null,
        notes: input.notes,
      },
    });
    if (updated.count !== 1) throw new PendingAdmissionUnavailableError();
  } else {
    await db.portalAdmission.create({
      data: {
        email,
        source: "PENDING_GRANT",
        status: "PENDING",
        admittedById: input.createdById,
        admittedAt: input.createdAt,
        notes: input.notes,
      },
    });
  }

  const grantData = {
    ...grantFieldsForRole(input.role, input.extraPermissions),
    status: "PENDING" as const,
    grantedById: input.createdById,
    grantedAt: input.createdAt,
    notes: input.notes,
  };
  if (options.expectedGrant) {
    const updated = await db.pendingCatalogGrant.updateMany({
      where: {
        email,
        catalogId: archive.id,
        status: options.expectedGrant.status,
        role: options.expectedGrant.role,
        extraPermissions: { equals: options.expectedGrant.extraPermissions },
      },
      data: {
        ...grantData,
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
      },
    });
    if (updated.count !== 1) throw new PendingAdmissionUnavailableError();
  } else if (options.expectedGrant === null) {
    // A concurrent grant must not bypass the role/extras authorization precheck.
    await db.pendingCatalogGrant.create({
      data: { email, catalogId: archive.id, ...grantData },
    });
  } else {
    await db.pendingCatalogGrant.upsert({
      where: { email_catalogId: { email, catalogId: archive.id } },
      create: { email, catalogId: archive.id, ...grantData },
      update: {
        ...grantData,
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
      },
    });
  }
}

export async function revokePendingAdmissionState(
  input: PendingAdmissionStateInput,
  options: RevokePendingAdmissionStateOptions,
  db: PendingAdmissionSyncClient = prisma
) {
  const archive = await requireArchive();
  if (input.catalogId !== null && input.catalogId !== archive.id)
    throw new ArchiveScopeError();
  const email = canonicalizeEmail(input.email);
  const now = new Date();
  const revoked = await db.portalAdmission.updateMany({
    where: { email, status: "PENDING" },
    data: {
      status: "REVOKED",
      revocationReason: options.reason,
      revokedById: options.actorId,
      revokedAt: now,
    },
  });
  if (revoked.count === 0) {
    const admission = await db.portalAdmission.findUnique({
      where: { email },
      select: { status: true },
    });
    if (admission?.status === "CLAIMED")
      throw new PendingAdmissionUnavailableError();
    if (!admission) {
      await db.portalAdmission.create({
        data: {
          email,
          source: "PENDING_GRANT",
          status: "REVOKED",
          revocationReason: options.reason,
          admittedById: input.createdById,
          admittedAt: input.createdAt,
          revokedById: options.actorId,
          revokedAt: now,
          notes: input.notes,
        },
      });
    }
    // An existing ADMIN_DENIED tombstone must survive a lower-privilege revoke.
  }
  const grantRevoked = await db.pendingCatalogGrant.updateMany({
    where: {
      email,
      catalogId: archive.id,
      status: "PENDING",
      ...(options.expectedGrant
        ? {
            role: options.expectedGrant.role,
            extraPermissions: {
              equals: options.expectedGrant.extraPermissions,
            },
          }
        : {}),
    },
    data: { status: "REVOKED", revokedById: options.actorId, revokedAt: now },
  });
  if (options.expectedGrant && grantRevoked.count !== 1)
    throw new PendingAdmissionUnavailableError();
}
