import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/me/permissions/route";

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

describe("me permissions route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getAdminCapability =
      accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
  });

  it("returns the typed admin capability payload", async () => {
    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      canAccessAdmin: true,
      hasEditorOnAnyCatalog: true,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      isSuperadmin: false,
      isAdmin: true,
      canAccessAdmin: true,
      hasEditorOnAnyCatalog: true,
    });
    expect(getAdminCapability).toHaveBeenCalledWith("admin-1");
  });
});
