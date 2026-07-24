import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  DELETE as deletePortalAdmission,
  GET as getPortalAdmission,
  PATCH as patchPortalAdmission,
} from "@/app/api/admin/portal-admissions/[email]/route";

const mocks = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/lib/admission/admin-pending-record-route", () => ({
  getAdminPendingRecord: mocks.getMock,
  patchAdminPendingRecord: mocks.patchMock,
  deleteAdminPendingRecord: mocks.deleteMock,
}));

describe("admin portal admissions item route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMock.mockResolvedValue(
      NextResponse.json({
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
      })
    );
    mocks.patchMock.mockResolvedValue(NextResponse.json({ ok: true }));
    mocks.deleteMock.mockResolvedValue(NextResponse.json({ ok: true }));
  });

  it("uses the shared admin pending-record handler for GET", async () => {
    const request = new NextRequest(
      "http://localhost/api/admin/portal-admissions/pending@example.com"
    );

    const response = await getPortalAdmission(request, {
      params: Promise.resolve({ email: "pending@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getMock).toHaveBeenCalledWith("pending@example.com");
    await expect(response.json()).resolves.toEqual({
      id: "pending@example.com",
      email: "pending@example.com",
      status: "PENDING",
      type: "portal_admission",
    });
  });

  it("uses the shared admin pending-record handler for PATCH", async () => {
    const request = new NextRequest(
      "http://localhost/api/admin/portal-admissions/pending@example.com",
      {
        method: "PATCH",
        body: JSON.stringify({ notes: "updated" }),
      }
    );

    const response = await patchPortalAdmission(request, {
      params: Promise.resolve({ email: "pending@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.patchMock).toHaveBeenCalledWith("pending@example.com", request);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      type: "portal_admission",
    });
  });

  it("uses the shared admin pending-record handler for DELETE", async () => {
    const request = new NextRequest(
      "http://localhost/api/admin/portal-admissions/pending@example.com",
      { method: "DELETE" }
    );

    const response = await deletePortalAdmission(request, {
      params: Promise.resolve({ email: "pending@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.deleteMock).toHaveBeenCalledWith("pending@example.com");
  });
});
