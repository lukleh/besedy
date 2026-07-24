import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogSettingsPage from "@/app/catalog/[catalogId]/settings/page";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  requireCatalogPageAccessMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
  notFound: mocks.notFoundMock,
}));

vi.mock("@/lib/access/catalog-page-access", () => ({
  requireCatalogPageAccess: mocks.requireCatalogPageAccessMock,
}));

vi.mock(
  "@/app/catalog/[catalogId]/settings/catalog-settings-content",
  () => ({
    default: ({
      catalogId,
      skipCatalogValidation,
    }: {
      catalogId: string;
      skipCatalogValidation?: boolean;
    }) => (
      <div
        data-testid="catalog-settings-content"
        data-catalog-id={catalogId}
        data-skip-catalog-validation={String(skipCatalogValidation ?? false)}
      />
    ),
  })
);

describe("CatalogSettingsPage", () => {
  const catalogId = "catalog-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "owner-1",
      capability: {
        catalogExists: true,
        hasAccess: true,
        canAccessSettings: true,
      },
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    mocks.requireCatalogPageAccessMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/auth/signin");
    });

    await expect(
      CatalogSettingsPage({
        params: Promise.resolve({ catalogId }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
  });

  it("returns not found when the catalog is unavailable", async () => {
    mocks.requireCatalogPageAccessMock.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      CatalogSettingsPage({
        params: Promise.resolve({ catalogId }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects users without management access back to the catalog", async () => {
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "owner-1",
      capability: {
        catalogExists: true,
        hasAccess: true,
        canAccessSettings: false,
      },
    });

    await expect(
      CatalogSettingsPage({
        params: Promise.resolve({ catalogId }),
      })
    ).rejects.toThrow(`NEXT_REDIRECT:/catalog/${catalogId}`);
  });

  it("renders the client settings workspace after the server access check", async () => {
    const page = await CatalogSettingsPage({
      params: Promise.resolve({ catalogId }),
    });

    render(page);

    const content = screen.getByTestId("catalog-settings-content");
    expect(content).toHaveAttribute("data-catalog-id", catalogId);
    expect(content).toHaveAttribute("data-skip-catalog-validation", "true");
    expect(mocks.requireCatalogPageAccessMock).toHaveBeenCalledWith(catalogId, {
      activeCatalogOnly: false,
    });
  });
});
