import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createPortalAdmission } from "@/lib/admission/admin-portal-admission-create";
import { patchAdminPendingRecord } from "@/lib/admission/admin-pending-record-route";

const CATALOG_ID = "20260101_000000";
const EMAIL = "pending@example.com";
const grantedAt = new Date("2026-01-01T00:00:00Z");

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAdminCapability: vi.fn(),
  loadPendingAdmissionState: vi.fn(),
  buildPendingGrantPresentation: vi.fn(),
  syncPendingAdmissionState: vi.fn(),
  revokePendingAdmissionState: vi.fn(),
  logPendingCatalogGrantEvent: vi.fn(),
  tx: { portalAdmission: { update: vi.fn() } },
  prisma: {
    workflowGroup: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    portalAdmission: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
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
vi.mock("@/lib/admission/pending-admission-sync", () => ({
  AdminDeniedAdmissionReopenError: class extends Error {},
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
  mocks.requireAuth.mockResolvedValue("admin-1");
  mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  mocks.prisma.workflowGroup.findUnique.mockResolvedValue({ id: CATALOG_ID, label: "Archive", isActive: true });
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  mocks.prisma.portalAdmission.findUnique.mockResolvedValue(null);
  mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
  mocks.tx.portalAdmission.update.mockResolvedValue({ email: EMAIL, notes: "updated" });
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
    catalogNames: ["Archive", "Second archive"],
    pendingGrantResponses: [],
  });
});

describe("admin invitation creation", () => {
  it.each([
    { email: EMAIL },
    { email: EMAIL, catalogId: CATALOG_ID },
    { email: EMAIL, role: "reader" },
  ])("rejects invitations without both a catalog and role: %j", async (body) => {
    const response = await createPortalAdmission(request(body));

    expect(response.status).toBe(400);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
  });

  it.each([null, { id: CATALOG_ID, isActive: false }])("requires an active catalog before writing an invitation: %j", async (catalog) => {
    mocks.prisma.workflowGroup.findUnique.mockResolvedValue(catalog);

    const response = await createPortalAdmission(
      request({ email: EMAIL, catalogId: CATALOG_ID, role: "reader" })
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
    mocks.prisma.workflowGroup.findUnique.mockResolvedValue({ id: "20260102_000000", isActive: false });

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
    const response = await patchAdminPendingRecord(EMAIL, request({ catalogId: null }, "PATCH"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Pending invitations must retain content access. Revoke the invitation instead.",
    });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("still updates the assigned role while preserving content access", async () => {
    const response = await patchAdminPendingRecord(EMAIL, request({ role: "corrector" }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: CATALOG_ID, role: "corrector" }),
      { allowAdminDeniedReopen: true },
      mocks.tx
    );
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
  });

  it("retains notes-only management of historical inactive grants", async () => {
    mocks.prisma.workflowGroup.findUnique.mockResolvedValue({ id: CATALOG_ID, label: "Old catalog", isActive: false });

    const response = await patchAdminPendingRecord(EMAIL, request({ notes: "operator review" }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: CATALOG_ID, role: "reader", notes: "operator review" }),
      { allowAdminDeniedReopen: true },
      mocks.tx
    );
  });

  it("retains notes-only management of legacy standalone admissions", async () => {
    const state = await mocks.loadPendingAdmissionState();
    mocks.loadPendingAdmissionState.mockResolvedValue({ ...state, pendingGrants: [] });

    const response = await patchAdminPendingRecord(EMAIL, request({ notes: "operator review" }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.syncPendingAdmissionState).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: null, role: null, notes: "operator review" }),
      { allowAdminDeniedReopen: true },
      mocks.tx
    );
  });

  it("retains notes-only editing of multi-catalog pending state until migration", async () => {
    const state = await mocks.loadPendingAdmissionState();
    mocks.loadPendingAdmissionState.mockResolvedValue({
      ...state,
      pendingGrants: [grant(), grant("20260102_000000")],
    });

    const response = await patchAdminPendingRecord(EMAIL, request({ notes: "updated" }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.tx.portalAdmission.update).toHaveBeenCalled();
    expect(mocks.syncPendingAdmissionState).not.toHaveBeenCalled();
    expect(mocks.revokePendingAdmissionState).not.toHaveBeenCalled();
  });
});
