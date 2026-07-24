import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/catalogs/[id]/capability/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

describe("catalog capability route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
  });

  it("returns 404 when catalog does not exist", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
      canManageAccess: false,
      canAccessSettings: false,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      {
        params: Promise.resolve({ id: "20260201_120000" }),
      }
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 when the catalog exists but the user has no access", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: false,
      canManageAccess: false,
      canAccessSettings: false,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      {
        params: Promise.resolve({ id: "20260201_120000" }),
      }
    );

    expect(response.status).toBe(404);
  });

  it("returns lightweight capability flags for authorized users", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canManageAccess: true,
      canAccessSettings: true,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      {
        params: Promise.resolve({ id: "20260201_120000" }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      canManageAccess: true,
      canAccessSettings: true,
    });
    expect(getCatalogCapability).toHaveBeenCalledWith(
      "20260201_120000",
      "user-1",
      { activeCatalogOnly: false }
    );
  });
});
