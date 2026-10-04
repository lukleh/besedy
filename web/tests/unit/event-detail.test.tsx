import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventDetail } from "@/components/catalog/event-detail";
import { ApiError } from "@/lib/api/fetch-json";
import type { EventDetailResponse } from "@/types/event-detail";

const CATALOG_ID = "20260101_120000";
const EVENT_ID = 7;
const useQueryMock = vi.fn();
const recordingContentMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => `/catalog/${CATALOG_ID}/event/${EVENT_ID}`,
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content", () => ({
  default: (props: { afterAudioPlayer?: ReactNode; headerActions?: ReactNode }) => {
    recordingContentMock(props);
    return (
      <div data-testid="recording-content">
        <div data-testid="header-actions">{props.headerActions}</div>
        {props.afterAudioPlayer}
      </div>
    );
  },
}));

// Menus render their items inline so the tests can read them without opening a portal.
vi.mock("@/components/ui/responsive-menu", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ResponsiveMenu: Passthrough,
    ResponsiveMenuTrigger: Passthrough,
    ResponsiveMenuContent: Passthrough,
    ResponsiveMenuItem: Passthrough,
    ResponsiveMenuRadioGroup: Passthrough,
    ResponsiveMenuRadioItem: Passthrough,
  };
});

vi.mock("@/hooks/use-local-package", () => ({
  useLocalArtworkUrl: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/offline/download-button", () => ({
  DownloadButton: () => null,
}));

vi.mock("@/components/catalog/event-sequence-navigation", () => ({
  EventSequenceNavigation: () => null,
}));

function eventDetail(overrides: Partial<EventDetailResponse> = {}): EventDetailResponse {
  return {
    id: EVENT_ID,
    workflowGroupId: CATALOG_ID,
    title: "Library, Jun 2006",
    location: { id: 1, name: "Library" },
    dateYear: 2006,
    dateMonth: 6,
    dateDay: null,
    sessionIndex: 1,
    sessionOrdinal: 1,
    sessionCount: 1,
    description: "Event description",
    released: true,
    recordings: [
      {
        audioHash: "a".repeat(64),
        isPrimary: true,
        sortOrder: 0,
        title: "Recording title",
        artist: null,
        durationHms: "01:00:00",
        verified: true,
        recorder: { id: 1, name: "Recorder" },
      },
    ],
    ...overrides,
  };
}

function renderEventDetail(data: EventDetailResponse, canEdit = false) {
  useQueryMock.mockReturnValue({ data, isLoading: false, error: null });
  renderComponent(canEdit);
}

function renderEventDetailError(error: unknown, refetch = vi.fn()) {
  useQueryMock.mockReturnValue({ data: undefined, isLoading: false, error, refetch, isFetching: false });
  renderComponent();
}

function renderComponent(canEdit = false) {
  render(
    <EventDetail
      catalogId={CATALOG_ID}
      eventId={EVENT_ID}
      canEdit={canEdit}
      showAllColumns={false}
      showReleaseState={false}
    />
  );
}

describe("EventDetail recording heading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("heads the selected recording with the event's date and location", () => {
    renderEventDetail(eventDetail());

    expect(recordingContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headingContext: {
          dateYear: 2006,
          dateMonth: 6,
          dateDay: null,
          locationName: "Library",
        },
      })
    );
  });

  it("does not repeat the derived event title below the player", () => {
    renderEventDetail(eventDetail());

    const content = screen.getByTestId("recording-content");
    expect(content).not.toHaveTextContent("Library, Jun 2006");
    expect(content).toHaveTextContent("Event description");
  });
});

describe("EventDetail load failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-found state with a way back to the events list", () => {
    renderEventDetailError(new ApiError("Catalog event not found", 404));

    expect(screen.getByRole("heading", { name: "notFoundTitle" })).toBeInTheDocument();
    expect(screen.getByText("notFoundDescription")).toBeInTheDocument();
    expect(screen.queryByText(/Catalog event not found/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /backToEvents/ })).toHaveAttribute(
      "href",
      `/catalog/${CATALOG_ID}?tab=events`
    );
    expect(screen.queryByRole("button", { name: /retry/ })).not.toBeInTheDocument();
  });

  it("treats an event hidden with 403 as not found", () => {
    renderEventDetailError(new ApiError("Forbidden", 403));

    expect(screen.getByRole("heading", { name: "notFoundTitle" })).toBeInTheDocument();
    expect(screen.queryByText("Forbidden")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/ })).not.toBeInTheDocument();
  });

  it("offers a retry for other failures without showing the raw error", () => {
    const refetch = vi.fn();
    renderEventDetailError(new ApiError("Internal error", 500), refetch);

    expect(screen.getByRole("heading", { name: "loadErrorTitle" })).toBeInTheDocument();
    expect(screen.getByText("errors.serverErrorDescription")).toBeInTheDocument();
    expect(screen.queryByText("Internal error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("EventDetail edit menu", () => {
  const eventPath = `/catalog/${CATALOG_ID}/event/${EVENT_ID}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function linkHrefs() {
    return screen.queryAllByRole("link").map((link) => link.getAttribute("href"));
  }

  it("puts every edit entry for a curator behind the one menu", () => {
    renderEventDetail(
      eventDetail({
        canViewArtworkCandidates: true,
        canManageSources: true,
        canEditMetadata: true,
        artworkStatus: "none",
      }),
      true
    );

    expect(screen.getByRole("button", { name: /editEvent/ })).toBeInTheDocument();
    expect(linkHrefs()).toEqual([
      `${eventPath}/edit`,
      `/catalog/${CATALOG_ID}/recording/${"a".repeat(64)}/edit`,
      `${eventPath}/artwork`,
      `${eventPath}/sources`,
    ]);
    // Missing artwork is a hint on its entry rather than a badge on the page.
    expect(screen.getByRole("link", { name: /editMenu.artwork/ })).toHaveTextContent("recording.noArtwork");
    // The menu replaces the player's own metadata button.
    expect(recordingContentMock).toHaveBeenCalledWith(expect.objectContaining({ hideMetadataEdit: true }));
  });

  it("names the recorder whose metadata is edited when the event has several", () => {
    const recording = eventDetail().recordings[0];
    renderEventDetail(
      eventDetail({
        canEditMetadata: true,
        recordings: [
          recording,
          { ...recording, audioHash: "b".repeat(64), isPrimary: false, recorder: { id: 2, name: "Second" } },
        ],
      })
    );

    expect(screen.getByRole("link", { name: /editMenu.recordingMetadata/ })).toHaveTextContent("Recorder");
  });

  it("offers artwork alone to an account granted artwork without event editing", () => {
    renderEventDetail(eventDetail({ canViewArtworkCandidates: true, artworkStatus: "published" }));

    expect(linkHrefs()).toEqual([`${eventPath}/artwork`]);
  });

  it("shows no edit menu to a reader", () => {
    renderEventDetail(eventDetail());

    expect(screen.queryByRole("button", { name: /editEvent/ })).not.toBeInTheDocument();
    expect(linkHrefs()).toEqual([]);
  });

  it("badges only an unreleased event", () => {
    renderEventDetail(eventDetail({ released: true }));
    expect(screen.queryByText("unreleased")).not.toBeInTheDocument();
    expect(screen.queryByText("released")).not.toBeInTheDocument();
  });

  it("badges an unreleased event", () => {
    renderEventDetail(eventDetail({ released: false }));
    expect(screen.getByText("unreleased")).toBeInTheDocument();
  });

  it("keeps the edit menu on an event without recordings", () => {
    renderEventDetail(eventDetail({ recordings: [], canManageSources: true }), true);

    expect(linkHrefs()).toEqual([`${eventPath}/edit`, `${eventPath}/sources`]);
  });
});
