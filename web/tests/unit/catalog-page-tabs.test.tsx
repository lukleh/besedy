import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogPageTabs } from "@/components/catalog/catalog-page-tabs";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  pathname: "/catalog/20260101_120000",
  replace: vi.fn(),
  setActiveTab: vi.fn(),
  useCatalogFeaturesMock: vi.fn(),
  useCatalogTabMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-catalog-features", () => ({
  useCatalogFeatures: (...args: unknown[]) => mocks.useCatalogFeaturesMock(...args),
}));

vi.mock("@/hooks/use-catalog-tab", () => ({
  useCatalogTab: (...args: unknown[]) => mocks.useCatalogTabMock(...args),
}));

vi.mock("@/components/catalog/catalog-list", () => ({
  CatalogList: ({ catalogId }: { catalogId: string }) => (
    <div data-testid="catalog-list" data-catalog-id={catalogId} />
  ),
}));

vi.mock("@/components/catalog/event-list", () => ({
  EventList: ({
    catalogId,
    canEdit,
    showAllColumns,
    showReleaseState,
    canUseRagSearch,
  }: {
    catalogId: string;
    canEdit: boolean;
    showAllColumns: boolean;
    showReleaseState: boolean;
    canUseRagSearch: boolean;
  }) => (
    <div
      data-testid="event-list"
      data-catalog-id={catalogId}
      data-can-edit={String(canEdit)}
      data-show-all-columns={String(showAllColumns)}
      data-show-release-state={String(showReleaseState)}
      data-can-use-rag-search={String(canUseRagSearch)}
    />
  ),
}));

vi.mock("@/components/catalog/catalog-tabs", () => ({
  CatalogTabs: ({
    activeTab,
    onChange,
  }: {
    activeTab: string;
    onChange: (tab: "recordings" | "events") => void;
  }) => (
    <div data-testid="catalog-tabs" data-active-tab={activeTab}>
      <button type="button" onClick={() => onChange("recordings")}>
        recordings
      </button>
      <button type="button" onClick={() => onChange("events")}>
        events
      </button>
    </div>
  ),
}));

describe("CatalogPageTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.pathname = "/catalog/20260101_120000";
    mocks.useCatalogTabMock.mockReturnValue({
      activeTab: "events",
      setActiveTab: mocks.setActiveTab,
      isSaving: false,
    });
  });

  it("defaults to the event list while feature data is loading", () => {
    mocks.useCatalogFeaturesMock.mockReturnValue({
      data: undefined,
      isPending: true,
    });

    render(<CatalogPageTabs catalogId="20260101_120000" />);

    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByTestId("event-list")).not.toBeInTheDocument();
  });

  it("falls back to the catalog list when the features query fails", () => {
    mocks.useCatalogFeaturesMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("features failed"),
    });

    render(<CatalogPageTabs catalogId="20260101_120000" />);

    expect(screen.getByTestId("catalog-list")).toBeInTheDocument();
    expect(screen.queryByTestId("event-list")).not.toBeInTheDocument();
  });

  it("shows only events for non-admin users without edit access", () => {
    mocks.useCatalogFeaturesMock.mockReturnValue({
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
            canUseRagSearch: false,
          },
        },
      },
      isPending: false,
    });

    render(<CatalogPageTabs catalogId="20260101_120000" />);

    expect(screen.queryByTestId("catalog-tabs")).not.toBeInTheDocument();
    expect(screen.getByTestId("event-list")).toHaveAttribute("data-can-edit", "false");
    expect(screen.getByTestId("event-list")).toHaveAttribute("data-show-release-state", "true");
    expect(screen.getByTestId("event-list")).toHaveAttribute("data-can-use-rag-search", "false");
    expect(screen.queryByTestId("catalog-list")).not.toBeInTheDocument();
  });

  it("shows the tab switcher for admins and honors the recordings tab from the url", () => {
    mocks.searchParams = new URLSearchParams("tab=recordings");
    mocks.useCatalogFeaturesMock.mockReturnValue({
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: true,
            showTabs: true,
            showAllColumns: true,
            showReleaseState: true,
            canUseRagSearch: true,
          },
        },
      },
      isPending: false,
    });
    mocks.useCatalogTabMock.mockReturnValue({
      activeTab: "recordings",
      setActiveTab: mocks.setActiveTab,
      isSaving: false,
    });

    render(<CatalogPageTabs catalogId="20260101_120000" />);

    expect(screen.getByTestId("catalog-tabs")).toHaveAttribute("data-active-tab", "recordings");
    expect(screen.getByTestId("catalog-list")).toBeInTheDocument();
    expect(mocks.useCatalogTabMock).toHaveBeenCalledWith("20260101_120000", true);
  });

  it("updates the url when an admin switches tabs from a deep-linked tab view", async () => {
    mocks.searchParams = new URLSearchParams("tab=recordings");
    mocks.useCatalogFeaturesMock.mockReturnValue({
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: true,
            showTabs: true,
            showAllColumns: true,
            showReleaseState: true,
            canUseRagSearch: true,
          },
        },
      },
      isPending: false,
    });
    mocks.useCatalogTabMock.mockReturnValue({
      activeTab: "recordings",
      setActiveTab: mocks.setActiveTab,
      isSaving: false,
    });

    const user = userEvent.setup();
    render(<CatalogPageTabs catalogId="20260101_120000" />);

    await user.click(screen.getByRole("button", { name: "events" }));

    expect(mocks.setActiveTab).toHaveBeenCalledWith("events");
    expect(mocks.replace).toHaveBeenCalledWith(
      "/catalog/20260101_120000?tab=events",
      { scroll: false }
    );
  });

  it("passes the owner-level full-column flag through to the event list", () => {
    mocks.useCatalogFeaturesMock.mockReturnValue({
      data: {
        features: {
          events: {
            rollout: "public",
            enabled: true,
            canView: true,
            canEdit: false,
            showTabs: false,
            showAllColumns: true,
            showReleaseState: true,
            canUseRagSearch: true,
          },
        },
      },
      isPending: false,
    });

    render(<CatalogPageTabs catalogId="20260101_120000" />);

    expect(screen.getByTestId("event-list")).toHaveAttribute("data-show-all-columns", "true");
    expect(screen.getByTestId("event-list")).toHaveAttribute("data-show-release-state", "true");
  });
});
