import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventUnassignedRecordingsPage } from "@/components/catalog/event-unassigned-recordings-page";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "candidateMeta") {
      return `Event ${values?.id}, session ${values?.index}`;
    }
    if (key === "count" || key === "unassignedCount") {
      return `${values?.count ?? 0}`;
    }
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

const catalogId = "20260201_120000";
const audioHash = "a".repeat(64);
const unassignedResponse = {
  entries: [
    {
      audioHash,
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      locationId: 7,
      locationName: "Praha",
      recorderName: "Recorder",
    },
  ],
  pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
};
const conflictPayload = {
  error: "Choose a destination",
  code: "CONFLICT",
  details: {
    reason: "EVENT_CREATION_REQUIRES_DECISION",
    candidates: [
      {
        id: 88,
        title: "Praha, 3 Apr 2024",
        sessionIndex: 1,
        recordingCount: 1,
        primaryTitle: "Existing discussion",
      },
    ],
  },
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventUnassignedRecordingsPage catalogId={catalogId} />
    </QueryClientProvider>
  );
}

describe("EventUnassignedRecordingsPage", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches the selected recording directly to a matching event", async () => {
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/catalog-events/unassigned?")) {
        return unassignedResponse;
      }
      if (url === "/api/catalog-events/from-recording") {
        throw new ApiError("Choose a destination", 409, conflictPayload);
      }
      if (url === `/api/catalogs/${catalogId}/events/88/recordings`) {
        expect(JSON.parse(String(init?.body))).toEqual({ audioHashes: [audioHash] });
        return {};
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "createFrom" }));
    expect(await screen.findByText("Existing discussion")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "attachToEvent" }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/catalog/${catalogId}/event/88/edit`);
    });
  });

  it("confirms semantic intent while the server allocates the session", async () => {
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/catalog-events/unassigned?")) {
        return unassignedResponse;
      }
      if (url === "/api/catalog-events/from-recording") {
        const body = JSON.parse(String(init?.body));
        if (body.intent !== "create_distinct") {
          throw new ApiError("Choose a destination", 409, conflictPayload);
        }
        expect(body).toEqual({
          workflowGroupId: catalogId,
          audioHash,
          intent: "create_distinct",
        });
        return { eventId: 89, audioHash, title: "New discussion" };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "createFrom" }));
    await user.click(await screen.findByRole("button", { name: "createDistinct" }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/catalog/${catalogId}/event/89/edit`);
    });
  });
});
