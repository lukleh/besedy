import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogPage from "@/app/catalog/[catalogId]/page";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  requireCatalogPageAccessMock: vi.fn(),
  getCatalogFeaturesForUserMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
  notFound: mocks.notFoundMock,
}));

vi.mock("@/lib/access/catalog-page-access", () => ({
  requireCatalogPageAccess: mocks.requireCatalogPageAccessMock,
}));

vi.mock("@/lib/features/capabilities", () => ({
  getCatalogFeaturesForUser: mocks.getCatalogFeaturesForUserMock,
}));

vi.mock("@/components/catalog/catalog-page-tabs", () => ({
  CatalogPageTabs: ({ catalogId }: { catalogId: string }) => (
    <div data-testid="catalog-page-tabs" data-catalog-id={catalogId} />
  ),
}));

describe("CatalogPage", () => {
  const catalogId = "20260101_120000";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "user-1",
      capability: {
        catalogExists: true,
        hasAccess: true,
      },
    });
    mocks.getCatalogFeaturesForUserMock.mockResolvedValue({
      catalogExists: true,
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: false,
            showTabs: false,
            showAllColumns: false,
            showReleaseState: true,
          },
        },
      },
    });
  });

  it("allows users with tab access to stay on the recordings tab", async () => {
    mocks.getCatalogFeaturesForUserMock.mockResolvedValue({
      catalogExists: true,
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: false,
            showTabs: true,
            showAllColumns: false,
            showReleaseState: true,
          },
        },
      },
    });

    const page = await CatalogPage({
      params: Promise.resolve({ catalogId }),
      searchParams: Promise.resolve({ tab: "recordings" }),
    });

    render(page);
    expect(screen.getByTestId("catalog-page-tabs")).toHaveAttribute(
      "data-catalog-id",
      catalogId
    );
    expect(mocks.requireCatalogPageAccessMock).toHaveBeenCalledWith(catalogId, {
      unauthorizedRedirect: "/catalog",
    });
  });

  it("redirects recordings deep links back to the default catalog view when tabs are hidden", async () => {
    mocks.getCatalogFeaturesForUserMock.mockResolvedValue({
      catalogExists: true,
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: false,
            showTabs: false,
            showAllColumns: false,
            showReleaseState: true,
          },
        },
      },
    });

    await expect(
      CatalogPage({
        params: Promise.resolve({ catalogId }),
        searchParams: Promise.resolve({ tab: "recordings" }),
      })
    ).rejects.toThrow(`NEXT_REDIRECT:/catalog/${catalogId}`);
  });

  it("redirects users without catalog access back to catalog index", async () => {
    mocks.requireCatalogPageAccessMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/catalog");
    });

    await expect(
      CatalogPage({
        params: Promise.resolve({ catalogId }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/catalog");
  });
});
