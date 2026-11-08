import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createPortalAdmission } from "@/lib/admission/admin-portal-admission-create";
import { PendingAdmissionUnavailableError } from "@/lib/admission/pending-admission-sync";
import { patchAdminPendingRecord } from "@/lib/admission/admin-pending-record-route";

const CATALOG_ID = "20260101_000000";
const EMAIL = "pending@example.com";
const grantedAt = new Date("2026-01-01T00:00:00Z");

const mocks = vi.hoisted(() => ({
  requireArchive: vi.fn(),
  requireAuth: vi.fn(),
  getAdminCapability: vi.fn(),
  loadPendingAdmissionState: vi.fn(),
  buildPendingGrantPresentation: vi.fn(),
  syncPendingAdmissionState: vi.fn(),
  revokePendingAdmissionState: vi.fn(),
  logPendingCatalogGrantEvent: vi.fn(),
  tx: {
    portalAdmission: { updateMany: vi.fn() },
    pendingCatalogGrant: { updateMany: vi.fn() },
  },
  prisma: {
    workflowGroup: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    portalAdmission: { findUnique: vi.fn() },
    pendingCatalogGrant: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/archive", async (original) => ({
  ...(await original<typeof import("@/lib/archive")>()),
  requireArchive: mocks.requireArchive,
}));
vi.mock("@/lib/db", () => ({ default: mocks.prisma }));
vi.mock("@/lib/auth/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/permissions")>()),
  requireAuth: mocks.requireAuth,
}));
vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: mocks.getAdminCapability,
}));
vi.mock("@/lib/admission/admin-pending-record-shared", () => ({
  loadPendingAdmissionState: mocks.loadPendingAdmissionState,
  buildPendingGrantPresentation: mocks.buildPendingGrantPresentation,
}));
vi.mock("@/lib/admission/pending-admission-sync", async (original) => ({
  ...(await original<
    typeof import("@/lib/admission/pending-admission-sync")
  >()),
  syncPendingAdmissionState: mocks.syncPendingAdmissionState,
  revokePendingAdmissionState: mocks.revokePendingAdmissionState,
}));
vi.mock("@/lib/audit/logger", () => ({
  logPendingCatalogGrantEvent: mocks.logPendingCatalogGrantEvent,
  logPortalAdmissionEvent: vi.fn(),
}));

function request(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/admin/portal-admissions", {
    method,
    body: JSON.stringify(body),
  });
}

function grant(catalogId = CATALOG_ID) {
  return {
    catalogId,
    role: "reader",
    extraPermissions: [],
    grantedById: "admin-1",
    grantedAt,
    notes: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireArchive.mockResolvedValue({ id: CATALOG_ID, label: "Archive" });
  mocks.requireAuth.mockResolvedValue("admin-1");
  mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  mocks.prisma.workflowGroup.findUnique.mockResolvedValue({
    id: CATALOG_ID,
    label: "Archive",
    isActive: true,
  });
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  mocks.prisma.portalAdmission.findUnique.mockResolvedValue(null);
  mocks.prisma.pendingCatalogGrant.findUnique.mockResolvedValue(null);
  mocks.prisma.$transaction.mockImplementation(async (callback) =>
    callback(mocks.tx)
  );
  mocks.tx.portalAdmission.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.pendingCatalogGrant.updateMany.mockResolvedValue({ count: 1 });
  mocks.loadPendingAdmissionState.mockResolvedValue({
    admission: {
      email: EMAIL,
      status: "PENDING",
      admittedById: "admin-1",
      admittedAt: grantedAt,
      notes: null,
    },
    pendingGrants: [grant()],
  });
  mocks.buildPendingGrantPresentation.mockResolvedValue({
    catalogNames: ["Archive"],
    pendingGrantResponses: [],
    pendingGrantCount: 1,
    singleCatalogLabel: "Archive",
  });
});

describe("admin invitation creation", () => {
  it.each([
    { email: EMAIL },
    { email: EMAIL, catalogId: CATALOG_ID },
    { email: EMAIL, role: "reader" },
  ])(
    "rejects invitations without both a catalog and role: %j",
    async (body) => {
      const response = await createPortalAdmission(request(body));

      expect(response.status).toBe(400);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    }
  );

  it("rejects a foreign source rather than silently granting bound access", async () => {
    const response = await createPortalAdmission(
      request({ email: EMAIL, catalogId: "20260202_000000", role: "reader" })
    );
    expect(response.status).toBe(404);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates admission and the assigned role/extras in the same transaction", async () => {
    const response = await createPortalAdmission(
      request({
        email: "Pending@Example.com",
        catalogId: CATALOG_ID,
        role: "reader",
        extraPermissions: ["bulk_export_transcripts"],
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        catalogId: CATALOG_ID,
        role: "reader",
        extraPermissions: ["bulk_export_transcripts"],
        createdById: "admin-1",
      }),
      { allowAdminDeniedReopen: true },
      mocks.tx
    );
    await expect(response.json()).resolves.toMatchObject({
      email: EMAIL,
      catalogAccess: {
        catalogId: CATALOG_ID,
        role: "reader",
        extraPermissions: ["bulk_export_transcripts"],
      },
    });
    expect(mocks.logPendingCatalogGrantEvent).toHaveBeenCalledWith(
      expect.objectContaining({ role: "reader", catalogId: CATALOG_ID })
    );
  });

  it("keeps the admin gate before request validation or writes", async () => {
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: false });

    const response = await createPortalAdmission(request({ email: EMAIL }));

    expect(response.status).toBe(403);
    expect(mocks.prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not recreate an existing account through an invitation", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "existing-user" });

    const response = await createPortalAdmission(
      request({ email: EMAIL, catalogId: CATALOG_ID, role: "reader" })
    );

    expect(response.status).toBe(409);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("pending invitation editing", () => {
  it("rejects reassignment to an inactive catalog before changing either record", async () => {
    mocks.prisma.workflowGroup.findUnique.mockResolvedValue({
      id: "20260102_000000",
      isActive: false,
    });

    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ catalogId: "20260102_000000", role: "reader" }, "PATCH")
    );

    expect(response.status).toBe(404);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("rejects removing the final content grant before changing either record", async () => {
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ catalogId: null }, "PATCH")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Pending invitations must retain content access. Revoke the invitation instead.",
    });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("still updates the assigned role while preserving content access", async () => {
    const state = await mocks.loadPendingAdmissionState();
    state.pendingGrants[0].extraPermissions = ["bulk_export_transcripts"];
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ role: "corrector" }, "PATCH")
    );

    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: CATALOG_ID,
        role: "corrector",
        extraPermissions: ["bulk_export_transcripts"],
      }),
      expect.objectContaining({
        allowAdminDeniedReopen: true,
        requirePending: true,
        expectedGrant: expect.objectContaining({
          role: "reader",
          status: "PENDING",
        }),
      }),
      mocks.tx
    );
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.prisma.pendingCatalogGrant.findUnique).not.toHaveBeenCalled();
  });

  it.each(["REVOKED", "CONSUMED"] as const)(
    "assigns an explicit role using the existing %s grant snapshot",
    async (status) => {
      const state = await mocks.loadPendingAdmissionState();
      mocks.loadPendingAdmissionState.mockResolvedValue({
        ...state,
        pendingGrants: [],
      });
      const historicalGrant = {
        role: "reader",
        extraPermissions: ["download_audio"],
        status,
      };
      mocks.prisma.pendingCatalogGrant.findUnique.mockResolvedValue(
        historicalGrant
      );

      const response = await patchAdminPendingRecord(
        EMAIL,
        request({ role: "corrector" }, "PATCH")
      );

      expect(response.status).toBe(200);
      expect(mocks.prisma.pendingCatalogGrant.findUnique).toHaveBeenCalledWith({
        where: { email_catalogId: { email: EMAIL, catalogId: CATALOG_ID } },
        select: { role: true, extraPermissions: true, status: true },
      });
      expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
        expect.objectContaining({ role: "corrector", extraPermissions: [] }),
        {
          allowAdminDeniedReopen: true,
          requirePending: true,
          expectedGrant: historicalGrant,
        },
        mocks.tx
      );
    }
  );

  it("rejects a fresh pending grant that appears after the pending read model was loaded", async () => {
    const state = await mocks.loadPendingAdmissionState();
    mocks.loadPendingAdmissionState.mockResolvedValue({
      ...state,
      pendingGrants: [],
    });
    mocks.prisma.pendingCatalogGrant.findUnique.mockResolvedValue({
      role: "catalog_admin",
      extraPermissions: ["bulk_export_transcripts"],
      status: "PENDING",
    });

    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ role: "listener", notes: "Stale save" }, "PATCH")
    );

    expect(response.status).toBe(409);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.tx.portalAdmission.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
  });

  it("updates bound notes without reopening or rewriting the role", async () => {
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ notes: "operator review" }, "PATCH")
    );
    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.tx.portalAdmission.updateMany).toHaveBeenCalledWith({
      where: { email: EMAIL, status: "PENDING" },
      data: { notes: "operator review" },
    });
    expect(mocks.tx.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: { email: EMAIL, catalogId: CATALOG_ID, status: "PENDING" },
      data: { notes: "operator review" },
    });
  });

  it("edits legacy standalone notes without creating implicit access", async () => {
    const state = await mocks.loadPendingAdmissionState();
    mocks.loadPendingAdmissionState.mockResolvedValue({
      ...state,
      pendingGrants: [],
    });
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ notes: "operator review" }, "PATCH")
    );
    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.tx.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.pendingCatalogGrant.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.portalAdmission.updateMany).toHaveBeenCalledWith({
      where: { email: EMAIL, status: "PENDING" },
      data: { notes: "operator review" },
    });
  });

  it("requires explicit role assignment before adding access to an unbacked admission", async () => {
    const state = await mocks.loadPendingAdmissionState();
    mocks.loadPendingAdmissionState.mockResolvedValue({
      ...state,
      pendingGrants: [],
    });
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ extraPermissions: ["download_audio"] }, "PATCH")
    );
    expect(response.status).toBe(400);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    const assigned = await patchAdminPendingRecord(
      EMAIL,
      request({ role: "reader", extraPermissions: ["download_audio"] }, "PATCH")
    );
    expect(assigned.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: CATALOG_ID,
        role: "reader",
        extraPermissions: ["download_audio"],
      }),
      {
        allowAdminDeniedReopen: true,
        requirePending: true,
        expectedGrant: null,
      },
      mocks.tx
    );
  });

  it("rejects a stale role save after revocation instead of reinviting", async () => {
    mocks.syncPendingAdmissionState.mockRejectedValueOnce(
      new PendingAdmissionUnavailableError()
    );
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ role: "corrector" }, "PATCH")
    );
    expect(response.status).toBe(409);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requirePending: true }),
      mocks.tx
    );
  });

  it("does not let a stale notes update reopen a revoked/claimed admission", async () => {
    mocks.tx.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    const response = await patchAdminPendingRecord(
      EMAIL,
      request({ notes: "late save" }, "PATCH")
    );
    expect(response.status).toBe(409);
    expect(mocks.tx.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
  });
});
