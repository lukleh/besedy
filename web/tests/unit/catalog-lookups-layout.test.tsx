import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetadataLayout from "@/app/(app)/catalog/[catalogId]/settings/metadata/layout";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  requireCatalogPageAccessMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
}));

vi.mock("@/lib/access/catalog-page-access", () => ({
  requireCatalogPageAccess: mocks.requireCatalogPageAccessMock,
}));

vi.mock(
  "@/app/(app)/catalog/[catalogId]/settings/metadata/metadata-layout-client",
  () => ({
    default: ({ catalogId, children }: { catalogId: string; children: ReactNode }) => (
      <div data-testid="lookups-layout" data-catalog-id={catalogId}>
        {children}
      </div>
    ),
  })
);

describe("catalog lookups layout", () => {
  const catalogId = "20260101_120000";

  const renderLayout = async () =>
    render(
      await MetadataLayout({
        children: <span>lookup list</span>,
        params: Promise.resolve({ catalogId }),
      })
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens for someone who may manage this catalog's lookups", async () => {
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "editor-1",
      capability: { canManageLookups: true },
    });

    await renderLayout();

    expect(screen.getByTestId("lookups-layout")).toHaveAttribute("data-catalog-id", catalogId);
    expect(screen.getByText("lookup list")).toBeInTheDocument();
    expect(mocks.requireCatalogPageAccessMock).toHaveBeenCalledWith(catalogId, {
      activeCatalogOnly: false,
    });
  });

  it("sends everyone else back to the catalog", async () => {
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "viewer-1",
      capability: { canManageLookups: false },
    });

    await expect(renderLayout()).rejects.toThrow(`NEXT_REDIRECT:/catalog/${catalogId}`);
  });

  it("leaves sign-in and missing catalogs to the page access check", async () => {
    mocks.requireCatalogPageAccessMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/auth/signin");
    });

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
  });
});
