import type { AccessLevel, PortalAdmissionRevocationReason, PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { canonicalizeEmail } from "@/lib/email";

type PendingAdmissionSyncClient = Pick<
  PrismaClient,
  "portalAdmission" | "pendingCatalogGrant"
>;

export interface PendingAdmissionStateInput {
  email: string;
  catalogId: string | null;
  accessLevel: AccessLevel | null;
  createdById: string | null;
  createdAt: Date;
  notes: string | null;
}

interface SyncPendingAdmissionStateOptions {
  allowAdminDeniedReopen?: boolean;
}

interface RevokePendingAdmissionStateOptions {
  actorId: string;
  reason: PortalAdmissionRevocationReason;
  revokeAllPendingGrantsForEmail?: boolean;
}

function hasPendingGrant(input: PendingAdmissionStateInput): input is PendingAdmissionStateInput & {
  catalogId: string;
  accessLevel: AccessLevel;
} {
  return input.catalogId !== null && input.accessLevel !== null;
}

export class AdminDeniedAdmissionReopenError extends Error {
  constructor(email: string) {
    super(`Only administrators can reopen admin-denied admission for ${email}`);
    this.name = "AdminDeniedAdmissionReopenError";
  }
}

export async function syncPendingAdmissionState(
  input: PendingAdmissionStateInput,
  options: SyncPendingAdmissionStateOptions = {},
  db: PendingAdmissionSyncClient = prisma
) {
  const email = canonicalizeEmail(input.email);
  const grantBacked = hasPendingGrant(input);
  const existingAdmission = await db.portalAdmission.findUnique({
    where: { email },
    select: {
      source: true,
      status: true,
      revocationReason: true,
      admittedById: true,
      admittedAt: true,
      notes: true,
    },
  });
  const preserveStandaloneAdmissionMetadata =
    grantBacked && existingAdmission?.source === "STANDALONE";
  const admissionSource =
    grantBacked && existingAdmission?.source !== "STANDALONE"
      ? "PENDING_GRANT"
      : "STANDALONE";
  const admittedById = preserveStandaloneAdmissionMetadata
    ? existingAdmission?.admittedById ?? null
    : input.createdById;
  const admittedAt = preserveStandaloneAdmissionMetadata
    ? existingAdmission?.admittedAt ?? input.createdAt
    : input.createdAt;
  const admissionNotes = preserveStandaloneAdmissionMetadata
    ? existingAdmission?.notes ?? null
    : input.notes;

  if (
    existingAdmission?.status === "REVOKED" &&
    existingAdmission.revocationReason === "ADMIN_DENIED" &&
    !options.allowAdminDeniedReopen
  ) {
    throw new AdminDeniedAdmissionReopenError(input.email);
  }

  await db.portalAdmission.upsert({
    where: { email },
    create: {
      email,
      source: admissionSource,
      status: "PENDING",
      revocationReason: null,
      admittedById,
      admittedAt,
      notes: admissionNotes,
    },
    update: {
      source: admissionSource,
      status: "PENDING",
      revocationReason: null,
      admittedById,
      admittedAt,
      revokedById: null,
      revokedAt: null,
      notes: admissionNotes,
    },
  });

  if (grantBacked) {
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
        accessLevel: input.accessLevel,
        status: "PENDING",
        grantedById: input.createdById,
        grantedAt: input.createdAt,
        notes: input.notes,
      },
      update: {
        accessLevel: input.accessLevel,
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
}

export async function revokePendingAdmissionState(
  input: PendingAdmissionStateInput,
  options: RevokePendingAdmissionStateOptions,
  db: PendingAdmissionSyncClient = prisma
) {
  const email = canonicalizeEmail(input.email);
  const now = new Date();
  const existingAdmission = await db.portalAdmission.findUnique({
    where: { email },
    select: {
      source: true,
    },
  });

  if (hasPendingGrant(input)) {
    await db.pendingCatalogGrant.updateMany({
      where: options.revokeAllPendingGrantsForEmail
        ? {
            email,
            status: "PENDING",
          }
        : {
            email,
            catalogId: input.catalogId,
            status: "PENDING",
          },
      data: {
        status: "REVOKED",
        revokedById: options.actorId,
        revokedAt: now,
      },
    });
  }

  const remainingPendingGrants = hasPendingGrant(input)
    ? await db.pendingCatalogGrant.count({
        where: {
          email,
          status: "PENDING",
        },
      })
    : 0;

  if (remainingPendingGrants === 0) {
    if (
      options.reason === "LAST_SPONSOR_REMOVED" &&
      existingAdmission?.source === "STANDALONE"
    ) {
      return;
    }

    await db.portalAdmission.upsert({
      where: { email },
      create: {
        email,
        source: hasPendingGrant(input) ? "PENDING_GRANT" : "STANDALONE",
        status: "REVOKED",
        revocationReason: options.reason,
        admittedById: input.createdById,
        admittedAt: input.createdAt,
        revokedById: options.actorId,
        revokedAt: now,
        notes: input.notes,
      },
      update: {
        status: "REVOKED",
        revocationReason: options.reason,
        revokedById: options.actorId,
        revokedAt: now,
      },
    });
  }
}
