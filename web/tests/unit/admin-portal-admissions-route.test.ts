import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  GET as listPortalAdmissions,
  POST as createPortalAdmission,
} from "@/app/api/admin/portal-admissions/route";

const mocks = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getAdminCapabilityMock: vi.fn(),
  listPendingAdminAdmissionsMock: vi.fn(),
  createPortalAdmissionMock: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: mocks.requireAuthMock,
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: mocks.getAdminCapabilityMock,
}));

vi.mock("@/lib/admission/admin-read-models", () => ({
  listPendingAdminAdmissions: mocks.listPendingAdminAdmissionsMock,
}));

vi.mock("@/lib/admission/admin-portal-admission-create", () => ({
  createPortalAdmission: mocks.createPortalAdmissionMock,
}));

describe("admin portal admissions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthMock.mockResolvedValue("admin-1");
    mocks.getAdminCapabilityMock.mockResolvedValue({ canAccessAdmin: true });
    mocks.listPendingAdminAdmissionsMock.mockResolvedValue([]);
    mocks.createPortalAdmissionMock.mockResolvedValue(NextResponse.json({ ok: true }));
  });

  it("returns pending portal admissions directly and preserves search", async () => {
    const request = new NextRequest(
      "http://localhost/api/admin/portal-admissions?search=pending"
    );

    const response = await listPortalAdmissions(request);

    expect(response.status).toBe(200);
    expect(mocks.listPendingAdminAdmissionsMock).toHaveBeenCalledWith("pending");
    await expect(response.json()).resolves.toEqual([]);
  });

  it("maps admissions into the portal-admission pending payload", async () => {
    mocks.listPendingAdminAdmissionsMock.mockResolvedValue([
      {
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
        invitedAt: "2026-03-10T10:00:00.000Z",
        pendingGrants: [],
        catalogNames: [],
        pendingGrantCount: 0,
        catalogId: null,
        catalogLabel: null,
        accessLevel: null,
        invitedBy: null,
        notes: "admission note",
      },
    ]);

    const response = await listPortalAdmissions(
      new NextRequest("http://localhost/api/admin/portal-admissions")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
        invitedAt: "2026-03-10T10:00:00.000Z",
        pendingGrants: [],
        catalogNames: [],
        pendingGrantCount: 0,
        catalogId: null,
        catalogLabel: null,
        accessLevel: null,
        invitedBy: null,
        notes: "admission note",
        type: "portal_admission",
      },
    ]);
  });

  it("rejects non-admin access", async () => {
    mocks.getAdminCapabilityMock.mockResolvedValue({ canAccessAdmin: false });

    const response = await listPortalAdmissions(
      new NextRequest("http://localhost/api/admin/portal-admissions")
    );

    expect(response.status).toBe(403);
  });

  it("uses the shared portal-admission create handler for POST", async () => {
    mocks.createPortalAdmissionMock.mockResolvedValue(
      NextResponse.json({
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
      })
    );

    const request = new NextRequest("http://localhost/api/admin/portal-admissions", {
      method: "POST",
      body: JSON.stringify({ email: "pending@example.com" }),
    });

    const response = await createPortalAdmission(request);

    expect(response.status).toBe(200);
    expect(mocks.createPortalAdmissionMock).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({
      id: "pending@example.com",
      email: "pending@example.com",
      status: "PENDING",
      type: "portal_admission",
    });
  });
});
