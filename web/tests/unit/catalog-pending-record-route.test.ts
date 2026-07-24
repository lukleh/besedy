import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  deletePendingCatalogRecord,
  updatePendingCatalogRecord,
} from "@/lib/admission/catalog-pending-record-route";

const CATALOG_ID = "20260101_000000";
const EMAIL = "pending@example.com";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  resolveCatalogManagementActor: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logPendingCatalogGrantEvent: vi.fn(),
}));

vi.mock("@/lib/admission/pending-admission-sync", () => ({
  AdminDeniedAdmissionReopenError: class AdminDeniedAdmissionReopenError extends Error {},
  revokePendingAdmissionState: vi.fn(),
  syncPendingAdmissionState: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    pendingCatalogGrant: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({})),
  },
}));

describe("catalog pending record route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogManagementActor: ReturnType<typeof vi.fn>;
  let revokePendingAdmissionState: ReturnType<typeof vi.fn>;
  let syncPendingAdmissionState: ReturnType<typeof vi.fn>;
  let prisma: {
    pendingCatalogGrant: { findUnique: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    resolveCatalogManagementActor = (
      await import("@/lib/access/catalog-management-route-access")
    ).resolveCatalogManagementActor as ReturnType<typeof vi.fn>;
    revokePendingAdmissionState = (
      await import("@/lib/admission/pending-admission-sync")
    ).revokePendingAdmissionState as ReturnType<typeof vi.fn>;
    syncPendingAdmissionState = (
      await import("@/lib/admission/pending-admission-sync")
    ).syncPendingAdmissionState as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("owner-1");
    resolveCatalogManagementActor.mockResolvedValue({
      ok: true,
      userId: "owner-1",
      catalogId: CATALOG_ID,
      actor: { catalogExists: true, isCatalogAdmin: false },
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
  });

  it("blocks owners from revoking pending OWNER grants", async () => {
    prisma.pendingCatalogGrant.findUnique.mockResolvedValue({
      email: EMAIL,
      catalogId: CATALOG_ID,
      accessLevel: "OWNER",
      grantedById: "admin-1",
      grantedAt: new Date("2026-01-01T00:00:00.000Z"),
      notes: "admin-only",
    });

    const response = await deletePendingCatalogRecord(CATALOG_ID, EMAIL);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only administrators can revoke OWNER access",
      code: "FORBIDDEN",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("returns 404 when deleting a pending record for a missing catalog", async () => {
    resolveCatalogManagementActor.mockResolvedValue({
      ok: true,
      userId: "admin-1",
      catalogId: CATALOG_ID,
      actor: { isCatalogAdmin: true, catalogExists: false },
      policyContext: {
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: null,
        isCatalogAdmin: true,
      },
    });

    const response = await deletePendingCatalogRecord(CATALOG_ID, EMAIL);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog not found",
      code: "NOT_FOUND",
    });
    expect(prisma.pendingCatalogGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("blocks owners from modifying existing pending OWNER grants", async () => {
    prisma.pendingCatalogGrant.findUnique.mockResolvedValue({
      email: EMAIL,
      catalogId: CATALOG_ID,
      accessLevel: "OWNER",
      grantedById: "admin-1",
      grantedAt: new Date("2026-01-01T00:00:00.000Z"),
      notes: "admin-only",
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/pending-catalog-grants/${EMAIL}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessLevel: "EDITOR" }),
      }
    );

    const response = await updatePendingCatalogRecord(CATALOG_ID, EMAIL, request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only administrators can modify OWNER access",
      code: "FORBIDDEN",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(syncPendingAdmissionState).not.toHaveBeenCalled();
  });

  it("returns 404 when updating a pending record for a missing catalog", async () => {
    resolveCatalogManagementActor.mockResolvedValue({
      ok: true,
      userId: "admin-1",
      catalogId: CATALOG_ID,
      actor: { isCatalogAdmin: true, catalogExists: false },
      policyContext: {
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: null,
        isCatalogAdmin: true,
      },
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/pending-catalog-grants/${EMAIL}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessLevel: "EDITOR" }),
      }
    );

    const response = await updatePendingCatalogRecord(CATALOG_ID, EMAIL, request);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog not found",
      code: "NOT_FOUND",
    });
    expect(prisma.pendingCatalogGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(syncPendingAdmissionState).not.toHaveBeenCalled();
  });
});
