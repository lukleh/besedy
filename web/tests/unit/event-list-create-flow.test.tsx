import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventListResponse } from "@/components/catalog/event-list-types";
import { EventList } from "@/components/catalog/event-list";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "candidateMeta") return `Event ${values?.id}`;
    return key;
  },
}));

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {
    status: number;
    payload?: unknown;

    constructor(message: string, status: number, payload?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  },
  fetchJson: vi.fn(),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsDesktop: () => true,
}));

vi.mock("@/components/catalog/catalog-list/hooks", () => ({
  useRagSearch: () => ({
    executeRagSearch: vi.fn(),
    exitRagMode: vi.fn(),
    handleRagSubmit: vi.fn(),
    hideRagMode: vi.fn(),
    isRagMode: false,
    ragError: null,
    ragLoading: false,
    ragQuery: "",
    ragResults: [],
    ragSubmittedQuery: "",
    setRagQuery: vi.fn(),
  }),
}));

vi.mock("@/components/catalog/event-list-results", () => ({
  EventListResults: ({
    events,
    onDateYearFilterChange,
  }: {
    events: { id: number; title: string }[];
    onDateYearFilterChange: (year: string) => void;
  }) => (
    <div data-testid="event-results">
      {events.map((event) => (
        <span key={event.id}>{event.title}</span>
      ))}
      <button onClick={() => onDateYearFilterChange("2025")}>
        Filter 2025
      </button>
    </div>
  ),
}));

const catalogId = "20260201_120000";
const conflictPayload = {
  error: "Choose an event",
  code: "CONFLICT",
  details: {
    reason: "EVENT_CREATION_REQUIRES_DECISION",
    candidates: [
      {
        id: 88,
        title: "Existing event",
        sessionIndex: 1,
        recordingCount: 1,
        primaryTitle: "Existing discussion",
      },
    ],
  },
};

function renderEventList() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <EventList
        catalogId={catalogId}
        canEdit
        showAllColumns
        showReleaseState
        canUseRagSearch={false}
      />
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

describe("EventList create flow", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(`/api/catalogs/${catalogId}/events?`)) {
        return {
          events: [],
          filterOptions: { years: [], locations: [] },
          pagination: {
            page: 1,
            limit: 50,
            total: 0,
            totalAll: 0,
            totalPages: 1,
          },
        };
      }
      if (url === `/api/catalogs/${catalogId}/metadata/locations`) {
        return [{ id: 7, name: "Praha" }];
      }
      if (url === `/api/catalogs/${catalogId}/events/health`) {
        return { unassignedRecordings: 0 };
      }
      if (url === `/api/catalogs/${catalogId}/events` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.intent !== "create_distinct") {
          throw new ApiError("Choose an event", 409, conflictPayload);
        }
        return { id: 89, title: "New event", recordingCount: 0 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("uses the same candidate decision flow for manual creation", async () => {
    const user = userEvent.setup();
    renderEventList();

    await user.click(await screen.findByRole("button", { name: "createEvent" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "fieldLocation" }),
      "7"
    );
    await user.type(screen.getByLabelText("fieldYear"), "2024");
    await user.click(screen.getByRole("button", { name: "create" }));

    expect(await screen.findByText("Existing discussion")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "createDistinct" }));

    await waitFor(() => {
      const createCalls = fetchJsonMock.mock.calls.filter(
        ([url, init]) =>
          url === `/api/catalogs/${catalogId}/events` && init?.method === "POST"
      );
      expect(createCalls).toHaveLength(2);
      const body = JSON.parse(String(createCalls[1][1]?.body));
      expect(body).not.toHaveProperty("workflowGroupId");
      expect(body).toMatchObject({
        locationId: 7,
        dateYear: 2024,
        intent: "create_distinct",
      });
    });
  });
});

function eventResponse(title: string, page = 1): EventListResponse {
  return {
    events: [
      {
        id: title === "First" ? 1 : title === "Next" ? 2 : 3,
        title,
        location: null,
        dateYear: 2025,
        dateMonth: null,
        dateDay: null,
        sessionIndex: 1,
        sessionOrdinal: 1,
        sessionCount: 1,
        released: true,
        recordingCount: 1,
        sourceCount: 1,
        artworkStatus: "none",
        primaryAudioHash: null,
        primaryTitle: null,
        playback: null,
      },
    ],
    filterOptions: { years: [2025], locations: [] },
    pagination: { page, limit: 50, total: 2, totalAll: 2, totalPages: 2 },
  };
}

describe("EventList progressive pagination", () => {
  const fetchJsonMock = vi.mocked(fetchJson);
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/metadata/locations")) return [];
      if (url.endsWith("/health")) return { unassignedRecordings: 0 };
      const params = new URL(url, "https://example.test").searchParams;
      return eventResponse(
        params.get("page") === "2" ? "Next" : "First",
        Number(params.get("page")),
      );
    });
  });

  it("drops accumulated event rows when the base query refreshes", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderEventList();
    expect(await screen.findByText("First")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "pagination.loadNext" }),
    );
    expect(await screen.findByText("Next")).toBeInTheDocument();
    fetchJsonMock.mockResolvedValueOnce(eventResponse("Refreshed"));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["catalog-events", catalogId],
      });
    });
    expect(await screen.findByText("Refreshed")).toBeInTheDocument();
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
  });

  it("aborts a pending event page and ignores its late response after filtering", async () => {
    const user = userEvent.setup();
    let resolveNext: ((value: EventListResponse) => void) | undefined;
    let signal: AbortSignal | undefined;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/metadata/locations")) return [];
      if (url.endsWith("/health")) return { unassignedRecordings: 0 };
      const params = new URL(url, "https://example.test").searchParams;
      if (params.get("page") === "2") {
        signal = init?.signal as AbortSignal;
        return new Promise<EventListResponse>((resolve) => {
          resolveNext = resolve;
        });
      }
      return eventResponse(params.has("dateYear") ? "Filtered" : "First");
    });
    renderEventList();
    expect(await screen.findByText("First")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "pagination.loadNext" }),
    );
    await user.click(screen.getByRole("button", { name: "Filter 2025" }));
    expect(await screen.findByText("Filtered")).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveNext?.(eventResponse("Next", 2)));
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
    expect(screen.getByText("Filtered")).toBeInTheDocument();
  });
});
