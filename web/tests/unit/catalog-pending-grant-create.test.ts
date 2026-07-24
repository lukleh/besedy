import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createPendingCatalogGrant } from "@/lib/admission/catalog-pending-grant-create";

const CATALOG_ID = "20260101_000000";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  resolveCatalogManagementActor: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logCatalogAccessEvent: vi.fn(),
  logPendingCatalogGrantEvent: vi.fn(),
}));

vi.mock("@/lib/admission/pending-admission-sync", () => ({
  AdminDeniedAdmissionReopenError: class AdminDeniedAdmissionReopenError extends Error {},
  syncPendingAdmissionState: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    portalAdmission: {
      findUnique: vi.fn(),
    },
    pendingCatalogGrant: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({})),
  },
}));

describe("catalog pending grant create", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogManagementActor: ReturnType<typeof vi.fn>;
  let syncPendingAdmissionState: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findUnique: ReturnType<typeof vi.fn> };
    user: { findUnique: ReturnType<typeof vi.fn> };
    portalAdmission: { findUnique: ReturnType<typeof vi.fn> };
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
    syncPendingAdmissionState = (
      await import("@/lib/admission/pending-admission-sync")
    ).syncPendingAdmissionState as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("owner-1");
    resolveCatalogManagementActor.mockResolvedValue({
      ok: true,
      userId: "owner-1",
      catalogId: CATALOG_ID,
      actor: { isCatalogAdmin: false },
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
    prisma.workflowGroup.findUnique.mockResolvedValue({
      id: CATALOG_ID,
      label: "Catalog",
    });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.portalAdmission.findUnique.mockResolvedValue(null);
  });

  it("blocks owners from reopening revoked pending OWNER grants through create", async () => {
    prisma.pendingCatalogGrant.findUnique.mockResolvedValue({
      accessLevel: "OWNER",
      status: "REVOKED",
    });

    const response = await createPendingCatalogGrant(
      new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/pending-catalog-grants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "pending@example.com",
            accessLevel: "EDITOR",
          }),
        }
      ),
      CATALOG_ID
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only administrators can modify OWNER access",
      code: "FORBIDDEN",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(syncPendingAdmissionState).not.toHaveBeenCalled();
  });
});
