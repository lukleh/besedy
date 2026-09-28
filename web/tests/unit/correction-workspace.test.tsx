import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionWorkspace } from "@/components/correction/correction-workspace";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {},
  fetchJson: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/correction/use-landscape-workspace", () => ({
  useLandscapeWorkspace: () => true,
}));

vi.mock("@/components/correction/correction-surface", () => ({
  CorrectionSurface: () => <div data-testid="correction-surface" />,
}));

const CATALOG_ID = "20251225_120000";
const HASH = "a".repeat(64);

function state(overrides: Record<string, unknown>) {
  return {
    catalogId: CATALOG_ID,
    audioHash: HASH,
    canStart: false,
    canPublish: true,
    guide: { revisionId: null, body: "guide", authorId: null, updatedAt: null, isDefault: true },
    candidateBackend: null,
    workspace: {
      id: "ws-1",
      catalogId: CATALOG_ID,
      audioHash: HASH,
      sourceBackend: "faster-whisper/large-v3@silero_vad_v6",
      sourceFingerprint: "f".repeat(64),
      spanCount: 2,
      spanDurationSeconds: 12,
      status: "ACTIVE",
      readerPublicationId: "pub-0",
      searchPublicationId: "pub-0",
      lockedByPublicationId: null,
      startedById: "user-1",
      createdAt: "2026-09-20T12:00:00.000Z",
    },
    progress: {
      spanCount: 2,
      totalDurationSeconds: 12,
      reviewedOnceDurationSeconds: 12,
      fullyApprovedDurationSeconds: 12,
      doneSpanCount: 2,
      blockedSpanCount: 0,
    },
    publication: {
      eligible: true,
      spanCount: 2,
      doneSpanCount: 2,
      blockedSpanCount: 0,
      unreviewedSpanCount: 0,
      awaitingSecondApprovalCount: 0,
    },
    activePublication: null,
    resume: null,
    ...overrides,
  };
}

const fetchJsonMock = vi.mocked(fetchJson);

function renderWorkspace(correctionState: ReturnType<typeof state>) {
  fetchJsonMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/correction")) return correctionState;
    if (url.endsWith("/entry")) return { entry: { hash: HASH, title: "Recording" } };
    throw new Error(`unexpected ${url}`);
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CorrectionWorkspace catalogId={CATALOG_ID} hash={HASH} userId="user-1" canPublish />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe("CorrectionWorkspace publication card", () => {
  it("offers publishing when nothing is in flight", async () => {
    renderWorkspace(state({}));

    expect(await screen.findByRole("button", { name: "republish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "unpublish" })).toBeEnabled();
  });

  // A publication waiting for the search index locks the workspace on the
  // server; the controls say so instead of letting a click be refused.
  it("disables publishing and unpublishing while a publication is in flight", async () => {
    renderWorkspace(
      state({
        activePublication: {
          id: "pub-1",
          status: "ACTIVATING",
          attemptCount: 1,
          indexJobId: "job-1",
          createdAt: "2026-09-28T10:00:00.000Z",
          error: null,
        },
      })
    );

    expect(await screen.findByText("publishInFlight")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "republish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "unpublish" })).toBeDisabled();
  });

  // A stalled publication is not a spinner forever: the cause is shown and
  // the publisher can pick it up again with the same authority they started
  // it with.
  it("shows why a publication stalled and offers a retry", async () => {
    renderWorkspace(
      state({
        activePublication: {
          id: "pub-1",
          status: "ACTIVATING",
          attemptCount: 2,
          indexJobId: null,
          createdAt: "2026-09-28T10:00:00.000Z",
          error: { code: "INDEX_SYNC_SUBMIT_FAILED", message: "jobs API unreachable" },
        },
      })
    );

    expect(await screen.findByTestId("publication-error")).toHaveTextContent(
      "INDEX_SYNC_SUBMIT_FAILED"
    );
    expect(screen.getByRole("button", { name: "retryPublish" })).toBeEnabled();
    expect(screen.queryByText("publishInFlight")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "unpublish" })).toBeDisabled();
  });

  it("does not offer a retry for a rollback that stalled", async () => {
    renderWorkspace(
      state({
        activePublication: {
          id: "pub-1",
          status: "ROLLING_BACK",
          attemptCount: 1,
          indexJobId: null,
          createdAt: "2026-09-28T10:00:00.000Z",
          error: { code: "INDEX_SYNC_FAILED", message: "worker fell over" },
        },
      })
    );

    expect(await screen.findByTestId("publication-error")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "retryPublish" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "republish" })).toBeDisabled();
  });
});
