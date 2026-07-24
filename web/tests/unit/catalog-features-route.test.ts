import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/catalogs/[id]/features/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/features/capabilities", () => ({
  getCatalogFeaturesForUser: vi.fn(),
}));

const deepSearchCapability = {
  rollout: "labs",
  enabled: false,
  canView: false,
};

describe("catalog features route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogFeaturesForUser: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const featuresModule = await import("@/lib/features/capabilities");
    getCatalogFeaturesForUser = featuresModule.getCatalogFeaturesForUser as ReturnType<typeof vi.fn>;
  });

  it("returns 404 when catalog does not exist", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogFeaturesForUser.mockResolvedValue({
      catalogExists: false,
      data: {
        labsEnabled: false,
        features: {
          events: {
            rollout: "public",
            enabled: false,
            canView: false,
            canEdit: false,
            showTabs: false,
            showAllColumns: false,
            showReleaseState: false,
          },
          deepSearch: deepSearchCapability,
        },
      },
    });

    const request = new NextRequest("http://localhost/api/catalogs/20260201_120000/features");
    const response = await GET(request, {
      params: Promise.resolve({ id: "20260201_120000" }),
    });

    expect(response.status).toBe(404);
  });

  it("returns capability payload when catalog exists", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogFeaturesForUser.mockResolvedValue({
      catalogExists: true,
      data: {
        labsEnabled: false,
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: false,
            showTabs: false,
            showAllColumns: false,
            showReleaseState: false,
          },
          deepSearch: {
            rollout: "labs",
            enabled: true,
            canView: true,
          },
        },
      },
    });

    const request = new NextRequest("http://localhost/api/catalogs/20260201_120000/features");
    const response = await GET(request, {
      params: Promise.resolve({ id: "20260201_120000" }),
    });

    expect(getCatalogFeaturesForUser).toHaveBeenCalledWith(
      "20260201_120000",
      "user-1",
      { activeCatalogOnly: undefined }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: true,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
        },
        deepSearch: {
          rollout: "labs",
          enabled: true,
          canView: true,
        },
      },
    });
  });

  it("opts into inactive catalog lookups when explicitly requested", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogFeaturesForUser.mockResolvedValue({
      catalogExists: true,
      data: {
        labsEnabled: false,
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: true,
            showTabs: true,
            showAllColumns: true,
            showReleaseState: true,
          },
          deepSearch: deepSearchCapability,
        },
      },
    });

    const request = new NextRequest(
      "http://localhost/api/catalogs/20260201_120000/features?includeInactive=true"
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "20260201_120000" }),
    });

    expect(response.status).toBe(200);
    expect(getCatalogFeaturesForUser).toHaveBeenCalledWith(
      "20260201_120000",
      "user-1",
      { activeCatalogOnly: false }
    );
  });
});
