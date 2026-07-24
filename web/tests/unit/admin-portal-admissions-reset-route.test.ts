import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postPortalAdmissionReset } from "@/app/api/admin/portal-admissions/reset/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/admission/admin-reset", () => ({
  resetClaimedPortalAdmission: vi.fn(),
  PortalAdmissionNotFoundError: class PortalAdmissionNotFoundError extends Error {},
  PortalAdmissionNotClaimedError: class PortalAdmissionNotClaimedError extends Error {},
  PortalAdmissionUserStillExistsError: class PortalAdmissionUserStillExistsError extends Error {},
}));

vi.mock("@/lib/audit/logger", () => ({
  logPortalAdmissionEvent: vi.fn(),
}));

describe("admin portal admission reset route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let resetClaimedPortalAdmission: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    const admissionResetModule = await import("@/lib/admission/admin-reset");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    resetClaimedPortalAdmission =
      admissionResetModule.resetClaimedPortalAdmission as ReturnType<typeof vi.fn>;
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("resets claimed portal admission for admins", async () => {
    requireAuth.mockResolvedValue("admin-1");
    resetClaimedPortalAdmission.mockResolvedValue({
      portalAdmissionId: "portal-1",
      email: "user@example.com",
      pendingGrantCount: 1,
      reopenedGrants: [
        {
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
        },
      ],
    });

    const request = new NextRequest("http://localhost/api/admin/portal-admissions/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "User@Example.com",
      }),
    });

    const response = await postPortalAdmissionReset(request);

    expect(response.status).toBe(200);
    expect(resetClaimedPortalAdmission).toHaveBeenCalledWith(
      "user@example.com",
      "admin-1"
    );
    expect(await response.json()).toEqual({
      success: true,
      email: "user@example.com",
      pendingGrantCount: 1,
      reopenedGrants: [
        {
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
        },
      ],
    });
  });

  it("returns conflict when the user still exists", async () => {
    const admissionResetModule = await import("@/lib/admission/admin-reset");
    const PortalAdmissionUserStillExistsError =
      admissionResetModule.PortalAdmissionUserStillExistsError as typeof Error;

    requireAuth.mockResolvedValue("admin-1");
    resetClaimedPortalAdmission.mockRejectedValue(
      new PortalAdmissionUserStillExistsError("user@example.com")
    );

    const request = new NextRequest("http://localhost/api/admin/portal-admissions/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
      }),
    });

    const response = await postPortalAdmissionReset(request);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "CONFLICT",
      error: "Delete the existing user before resetting portal admission",
    });
  });
});
