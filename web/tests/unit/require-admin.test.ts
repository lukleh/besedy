import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/permissions";
import { requireAdminCapability } from "@/lib/access/require-admin";

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

describe("requireAdminCapability", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const capabilityModule = await import("@/lib/access/capabilities");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = capabilityModule.getAdminCapability as ReturnType<typeof vi.fn>;
  });

  it("returns the user id and capability for admin users", async () => {
    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({
      canAccessAdmin: true,
      isAdmin: true,
      isSuperadmin: false,
    });

    await expect(requireAdminCapability()).resolves.toEqual({
      userId: "admin-1",
      capability: {
        canAccessAdmin: true,
        isAdmin: true,
        isSuperadmin: false,
      },
    });
  });

  it("throws an AuthError with the custom message for non-admin users", async () => {
    requireAuth.mockResolvedValue("user-1");
    getAdminCapability.mockResolvedValue({
      canAccessAdmin: false,
      isAdmin: false,
      isSuperadmin: false,
    });

    await expect(
      requireAdminCapability({ message: "Custom admin message" })
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      requireAdminCapability({ message: "Custom admin message" })
    ).rejects.toMatchObject({
      message: "Custom admin message",
      statusCode: 403,
      name: "AuthError",
    });
  });
});
