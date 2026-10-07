import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/catalogs/[id]/capability/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  findActiveCatalog: vi.fn(),
}));

describe("catalog capability route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let findActiveCatalog: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
    findActiveCatalog = (await import("@/lib/catalog/resolve-group"))
      .findActiveCatalog as ReturnType<typeof vi.fn>;
    findActiveCatalog.mockResolvedValue({ id: "20260201_120000" });
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
      canCorrectTranscripts: true,
      canPublishTranscript: false,
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
      canViewCorrectionOverview: true,
    });
    expect(getCatalogCapability).toHaveBeenCalledWith(
      "20260201_120000",
      "user-1",
      { activeCatalogOnly: false }
    );
  });

  it("follows the correction page, which publishing alone does not open", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canManageAccess: false,
      canAccessSettings: false,
      canCorrectTranscripts: false,
      canPublishTranscript: true,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      { params: Promise.resolve({ id: "20260201_120000" }) }
    );

    await expect(response.json()).resolves.toMatchObject({ canViewCorrectionOverview: false });
  });

  it("keeps the correction overview from everybody else", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canManageAccess: false,
      canAccessSettings: false,
      canCorrectTranscripts: false,
      canPublishTranscript: false,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      { params: Promise.resolve({ id: "20260201_120000" }) }
    );

    await expect(response.json()).resolves.toMatchObject({ canViewCorrectionOverview: false });
  });

  // The overview serves active catalogs only; a link to it from an inactive
  // one would open a page that answers 404.
  it("does not offer the correction overview for an inactive catalog", async () => {
    requireAuth.mockResolvedValue("user-1");
    findActiveCatalog.mockResolvedValue(null);
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canManageAccess: true,
      canAccessSettings: true,
      canCorrectTranscripts: true,
      canPublishTranscript: true,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/catalogs/20260201_120000/capability"),
      { params: Promise.resolve({ id: "20260201_120000" }) }
    );

    await expect(response.json()).resolves.toMatchObject({
      canManageAccess: true,
      canViewCorrectionOverview: false,
    });
  });
});
