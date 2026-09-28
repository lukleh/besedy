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
  default: (props: { afterAudioPlayer?: ReactNode }) => {
    recordingContentMock(props);
    return <div data-testid="recording-content">{props.afterAudioPlayer}</div>;
  },
}));

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

function renderEventDetail(data: EventDetailResponse) {
  useQueryMock.mockReturnValue({ data, isLoading: false, error: null });
  renderComponent();
}

function renderEventDetailError(error: unknown, refetch = vi.fn()) {
  useQueryMock.mockReturnValue({ data: undefined, isLoading: false, error, refetch, isFetching: false });
  renderComponent();
}

function renderComponent() {
  render(
    <EventDetail
      catalogId={CATALOG_ID}
      eventId={EVENT_ID}
      canEdit={false}
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
