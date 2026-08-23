import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventListResults } from "@/components/catalog/event-list-results";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "recordingsMobile") return `Recordings: ${values?.count ?? ""}`;
    if (key === "sourcesMobile") return `Sources: ${values?.count ?? ""}`;
    if (key === "postersMobile") return `Posters: ${values?.status ?? ""}`;
    return key;
  },
}));

const BASE_PROPS = {
  catalogId: "20260101_120000",
  dateYearFilter: "all",
  events: [
    {
      id: 1,
      title: null,
      location: { id: 7, name: "Prague" },
      dateYear: 2024,
      dateMonth: 5,
      dateDay: 2,
      sessionIndex: 1,
      released: true,
      recordingCount: 3,
      sourceCount: 2,
      posterStatus: { portrait: true, landscape: true },
      primaryTitle: "Primary track",
      playback: null,
    },
  ],
  hasActiveFilters: false,
  locationFilter: "all",
  locationOptions: [],
  onDateYearFilterChange: vi.fn(),
  onLocationFilterChange: vi.fn(),
  onReleasedFilterChange: vi.fn(),
  onSort: vi.fn(),
  releasedFilter: "all" as const,
  sortDir: "desc" as const,
  sortKey: "date" as const,
  yearOptions: [2024],
};

describe("EventListResults", () => {
  it("shows listener columns without owner-only fields", () => {
    render(
      <EventListResults
        {...BASE_PROPS}
        showAllColumns={false}
        showReleaseState={false}
      />
    );

    expect(screen.getByText("columnDate")).toBeInTheDocument();
    expect(screen.getByText("columnLocation")).toBeInTheDocument();
    expect(screen.getByText("columnProgress")).toBeInTheDocument();
    expect(screen.queryByText("columnRecordings")).not.toBeInTheDocument();
    expect(screen.queryByText("columnStatus")).not.toBeInTheDocument();
    expect(screen.queryByText("Recordings: 3")).not.toBeInTheDocument();
    expect(screen.queryByText("released")).not.toBeInTheDocument();
  });

  it("keeps release visibility without owner-only columns", () => {
    render(
      <EventListResults
        {...BASE_PROPS}
        showAllColumns={false}
        showReleaseState
      />
    );

    expect(screen.queryByText("columnRecordings")).not.toBeInTheDocument();
    expect(screen.getAllByText("released").length).toBeGreaterThan(0);
  });

  it("keeps the mobile card limited to date and location", () => {
    render(
      <EventListResults
        {...BASE_PROPS}
        showAllColumns
        showReleaseState
      />
    );

    const mobileCard = screen.getByTestId("event-card-1");

    expect(mobileCard.tagName).toBe("BUTTON");
    expect(mobileCard).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: /May 2, 2024/i })).toBe(mobileCard);
    expect(within(mobileCard).getByText("May 2, 2024")).toBeInTheDocument();
    expect(within(mobileCard).getByText("Prague")).toBeInTheDocument();
    expect(within(mobileCard).queryByText("Recordings: 3")).not.toBeInTheDocument();
    expect(within(mobileCard).queryByText("Primary track")).not.toBeInTheDocument();
    expect(within(mobileCard).queryByText("released")).not.toBeInTheDocument();
  });

  it("shows the extra owner columns when enabled", () => {
    render(<EventListResults {...BASE_PROPS} showAllColumns showReleaseState />);

    expect(screen.getByText("columnRecordings")).toBeInTheDocument();
    expect(screen.getByText("columnStatus")).toBeInTheDocument();
    expect(screen.getAllByText("Primary track").length).toBeGreaterThan(0);
    expect(screen.getAllByText("released").length).toBeGreaterThan(0);
  });

  it("shows listening progress on the mobile event card", () => {
    render(
      <EventListResults
        {...BASE_PROPS}
        events={[
          {
            ...BASE_PROPS.events[0],
            playback: {
              positionSec: 900,
              durationSec: 3600,
              percent: 25,
              completed: false,
            },
          },
        ]}
        showAllColumns={false}
        showReleaseState={false}
      />
    );

    expect(screen.getAllByLabelText("percentListened").length).toBeGreaterThan(0);
    expect(screen.getAllByText("25%").length).toBeGreaterThan(0);
  });

  it("places desktop progress in the fixed rightmost column", () => {
    render(
      <EventListResults
        {...BASE_PROPS}
        events={[
          {
            ...BASE_PROPS.events[0],
            playback: {
              positionSec: 900,
              durationSec: 3600,
              percent: 25,
              completed: false,
            },
          },
        ]}
        showAllColumns={false}
        showReleaseState={false}
      />
    );

    const desktopTable = screen.getByRole("table");
    const progress = within(desktopTable).getByLabelText("percentListened");
    const progressCell = progress.closest("td");

    expect(progressCell).toBe(progressCell?.parentElement?.lastElementChild);
    expect(progressCell).toHaveClass("w-36", "text-right");
    expect(progress).toHaveClass("inline-flex");
  });
});
