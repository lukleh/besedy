import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogSettingsPage from "@/app/(app)/catalog/[catalogId]/settings/page";
import type { CatalogSettingsCards } from "@/app/(app)/catalog/[catalogId]/settings/catalog-settings-content-types";

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

vi.mock(
  "@/app/(app)/catalog/[catalogId]/settings/catalog-settings-content",
  () => ({
    default: ({
      catalogId,
      cards,
      skipCatalogValidation,
    }: {
      catalogId: string;
      cards: CatalogSettingsCards;
      skipCatalogValidation?: boolean;
    }) => (
      <div
        data-testid="catalog-settings-content"
        data-catalog-id={catalogId}
        data-cards={Object.entries(cards)
          .filter(([, visible]) => visible)
          .map(([name]) => name)
          .sort()
          .join(",")}
        data-skip-catalog-validation={String(skipCatalogValidation ?? false)}
      />
    ),
  })
);

describe("CatalogSettingsPage", () => {
  const catalogId = "catalog-1";

  const capability = (overrides: Record<string, boolean> = {}) => ({
    catalogExists: true,
    hasAccess: true,
    canBulkExportTranscripts: false,
    canViewTranscripts: false,
    canManageCatalogConfiguration: false,
    canManageAccess: false,
    canEditCorrectionGuide: false,
    ...overrides,
  });

  const withCapability = (overrides: Record<string, boolean> = {}) => {
    mocks.requireCatalogPageAccessMock.mockResolvedValue({
      userId: "owner-1",
      capability: capability(overrides),
    });
  };

  const withEventEditing = (canEdit: boolean) => {
    mocks.getCatalogFeaturesForUserMock.mockResolvedValue({
      data: { features: { events: { canEdit } } },
    });
  };

  const renderPage = async () => {
    render(await CatalogSettingsPage({ params: Promise.resolve({ catalogId }) }));
    return screen.getByTestId("catalog-settings-content");
  };

  beforeEach(() => {
    vi.clearAllMocks();
    withCapability({
      canBulkExportTranscripts: true,
      canViewTranscripts: true,
      canManageCatalogConfiguration: true,
      canManageAccess: true,
      canEditCorrectionGuide: true,
    });
    withEventEditing(true);
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

  it("redirects back to the catalog when no card is visible", async () => {
    withCapability();
    withEventEditing(false);

    await expect(
      CatalogSettingsPage({
        params: Promise.resolve({ catalogId }),
      })
    ).rejects.toThrow(`NEXT_REDIRECT:/catalog/${catalogId}`);
  });

  it("renders the client settings workspace after the server access check", async () => {
    const content = await renderPage();

    expect(content).toHaveAttribute("data-catalog-id", catalogId);
    expect(content).toHaveAttribute("data-skip-catalog-validation", "true");
    expect(mocks.requireCatalogPageAccessMock).toHaveBeenCalledWith(catalogId, {
      activeCatalogOnly: false,
    });
    expect(content).toHaveAttribute(
      "data-cards",
      "access,configuration,correctionGuide,eventHealth,transcriptExports"
    );
  });

  // Each card is its own permission, so any one of them is enough to open the
  // page, and the page hands the client exactly the cards that one permits.
  const singleCardCases: Array<{
    name: string;
    capability: Record<string, boolean>;
    events: boolean;
    cards: string;
  }> = [
    {
      name: "transcript exports",
      capability: { canBulkExportTranscripts: true },
      events: false,
      cards: "transcriptExports",
    },
    {
      name: "configuration",
      capability: { canManageCatalogConfiguration: true },
      events: false,
      cards: "configuration",
    },
    {
      name: "event health",
      capability: {},
      events: true,
      cards: "eventHealth",
    },
    {
      name: "access",
      capability: { canManageAccess: true },
      events: false,
      cards: "access",
    },
    {
      name: "correction guide",
      capability: { canEditCorrectionGuide: true },
      events: false,
      cards: "correctionGuide",
    },
  ];

  it.each(singleCardCases)("opens the page for $name alone", async ({ capability, events, cards }) => {
    withCapability(capability);
    withEventEditing(events);

    expect(await renderPage()).toHaveAttribute("data-cards", cards);
  });

});
