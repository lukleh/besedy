import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  EventListResults: () => <div data-testid="event-results" />,
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
  return render(
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
}

describe("EventList create flow", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/catalog-events?")) {
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
      if (url === `/api/metadata/locations?group=${catalogId}`) {
        return [{ id: 7, name: "Praha" }];
      }
      if (url === `/api/catalogs/${catalogId}/events/health`) {
        return { unassignedRecordings: 0 };
      }
      if (url === "/api/catalog-events" && init?.method === "POST") {
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
          url === "/api/catalog-events" && init?.method === "POST"
      );
      expect(createCalls).toHaveLength(2);
      expect(JSON.parse(String(createCalls[1][1]?.body))).toMatchObject({
        workflowGroupId: catalogId,
        locationId: 7,
        dateYear: 2024,
        intent: "create_distinct",
      });
    });
  });
});
