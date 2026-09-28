import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionSurface } from "@/components/correction/correction-surface";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ audioPlayer: vi.fn() }));

vi.mock("@/components/player/audio-player", () => ({
  AudioPlayer: (props: unknown) => {
    mocks.audioPlayer(props);
    return <div data-testid="audio-player" />;
  },
}));

const CATALOG_ID = "20251225_120000";
const HASH = "a".repeat(64);
const WORKSPACE = {
  id: "ws-1",
  catalogId: CATALOG_ID,
  audioHash: HASH,
  sourceBackend: "faster-whisper/large-v3@silero_vad_v6",
  sourceFingerprint: "f".repeat(64),
  spanCount: 250,
  spanDurationSeconds: 2500,
  status: "ACTIVE" as const,
  readerPublicationId: null,
  searchPublicationId: null,
  lockedByPublicationId: null,
  startedById: "user-1",
  createdAt: "2026-09-20T12:00:00.000Z",
};

function span(ordinal: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `span-${ordinal}`,
    ordinal,
    startSeconds: ordinal * 10,
    endSeconds: ordinal * 10 + 10,
    originalText: `machine ${ordinal}`,
    text: `machine ${ordinal}`,
    revisionId: `rev-${ordinal}-1`,
    isEdited: false,
    state: "not_reviewed",
    approverIds: [],
    disapproverIds: [],
    commentCount: 0,
    lastEditedById: null,
    lastEditedAt: null,
    ...overrides,
  };
}

function page(offset: number, count: number, total: number, spans = Array.from({ length: count }, (_, i) => span(offset + i))) {
  return { workspaceId: WORKSPACE.id, offset, limit: 200, total, spans };
}

function renderSurface(resume: { spanId: string; ordinal: number } | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CorrectionSurface
        catalogId={CATALOG_ID}
        hash={HASH}
        userId="user-1"
        workspace={WORKSPACE}
        resume={resume}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  );
}

const fetchJsonMock = vi.mocked(fetchJson);

beforeEach(() => {
  fetchJsonMock.mockReset();
  mocks.audioPlayer.mockClear();
});

function lastPlayerProps() {
  return mocks.audioPlayer.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("CorrectionSurface", () => {
  // Nobody finishes a long recording in one sitting, so the list opens on the
  // page holding the resume position. The pages before it still have to be
  // reachable, or a corrector could never revisit the beginning.
  it("opens on the resume span and can load the pages before it", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/spans?offset=200")) return page(200, 50, 250);
      if (url.includes("/spans?offset=0")) return page(0, 200, 250);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface({ spanId: "span-210", ordinal: 210 });

    expect(await screen.findByDisplayValue("machine 210")).toBeInTheDocument();
    expect(screen.queryByText("machine 0")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "loadEarlier" }));

    await waitFor(() => {
      expect(screen.getByText("machine 0")).toBeInTheDocument();
    });
    // The list stays in recording order once the earlier page is prepended.
    const listed = screen.getAllByText(/^machine \d+$/).map((node) => node.textContent);
    expect(listed.indexOf("machine 0")).toBeLessThan(listed.indexOf("machine 210"));
    expect(screen.queryByRole("button", { name: "loadEarlier" })).not.toBeInTheDocument();
  });

  // A conflict must not throw the person's wording away, and it must show
  // them what they are now conflicting with, or they cannot decide whether
  // their change still applies.
  it("keeps the draft and shows the current text after a revision conflict", async () => {
    let spansServed = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) {
        spansServed += 1;
        return spansServed === 1
          ? page(0, 1, 1)
          : page(0, 1, 1, [span(0, { text: "their text", revisionId: "rev-0-2", isEdited: true })]);
      }
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        throw new ApiError("conflict", 409, { code: "REVISION_CONFLICT" });
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);

    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    await userEvent.click(screen.getByRole("button", { name: "saveApproveAndContinue" }));

    await waitFor(() => {
      expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text");
    });
    expect(editor).toHaveValue("my text");
    expect(screen.getByText("conflict")).toBeInTheDocument();
  });

  // Opening on a later segment must position the audio there, or Play starts
  // wherever the player last was. Positioning is not playing: nothing should
  // start on its own when the page opens.
  it("positions the audio on the initially selected span without playing", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/spans?offset=200")) return page(200, 50, 250);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface({ spanId: "span-210", ordinal: 210 });
    await screen.findByDisplayValue("machine 210");

    await waitFor(() => {
      expect(lastPlayerProps()).toMatchObject({
        seekTo: 2100,
        playbackEnd: 2110,
        autoPlayOnSeek: false,
      });
    });
  });

  // Any refresh can bring a newer revision, not only a failed command. A
  // dirty draft must survive it and be flagged, or a comment posted while
  // somebody else saved would silently replace the wording.
  it("keeps a dirty draft when a refresh brings a newer revision", async () => {
    let spansServed = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) {
        spansServed += 1;
        return spansServed === 1
          ? page(0, 1, 1)
          : page(0, 1, 1, [span(0, { text: "their text", revisionId: "rev-0-2", isEdited: true })]);
      }
      if (url.endsWith("/comments") && init?.method === "POST") {
        return { id: "comment-1", createdAt: "2026-09-28T10:00:00.000Z" };
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);

    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "a note");
    await userEvent.click(screen.getByRole("button", { name: "addComment" }));

    await waitFor(() => {
      expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text");
    });
    expect(editor).toHaveValue("my text");
  });

  // The sidebar stays clickable while a command is in flight. Whoever has
  // moved on must not be moved again when the earlier command lands.
  it("advances from the approved span only while it is still selected", async () => {
    let resolveApprove: (value: unknown) => void = () => {};
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) return page(0, 3, 3);
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveApprove = resolve;
        });
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    await userEvent.click(screen.getByRole("button", { name: "approveAndContinue" }));
    await userEvent.click(screen.getByRole("button", { name: /machine 2/ }));
    await screen.findByDisplayValue("machine 2");

    resolveApprove({
      spanId: "span-0",
      revisionId: "rev-0-1",
      text: "machine 0",
      state: "needs_second_approval",
      approverIds: ["user-1"],
      disapproverIds: [],
      replayed: false,
    });

    await waitFor(() => {
      expect(fetchJsonMock.mock.calls.filter(([input]) => String(input).includes("/spans?offset=0")).length).toBeGreaterThan(1);
    });
    expect(screen.getByDisplayValue("machine 2")).toBeInTheDocument();
  });

  // When the answer to a command is lost, repeating it must carry the same
  // key, so the server replays what it recorded instead of refusing the now
  // stale revision.
  it("reuses the idempotency key when the same command is retried after a lost response", async () => {
    let attempts = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) return page(0, 1, 1);
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return {
          spanId: "span-0",
          revisionId: "rev-0-1",
          text: "machine 0",
          state: "needs_second_approval",
          approverIds: ["user-1"],
          disapproverIds: [],
          replayed: true,
        };
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    await userEvent.click(screen.getByRole("button", { name: "disapprove" }));
    await waitFor(() => expect(attempts).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "disapprove" }));
    await waitFor(() => expect(attempts).toBe(2));

    const keys = fetchJsonMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  // Resolving a disagreement means reading what each revision said, not only
  // that one happened.
  it("shows the wording of each revision in the history", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) return page(0, 1, 1);
      if (/\/spans\/span-0$/.test(url)) {
        return {
          spanId: "span-0",
          history: [
            {
              kind: "revision",
              at: "2026-09-27T10:00:00.000Z",
              userId: "user-2",
              actorName: "Bob",
              revisionId: "rev-0-0",
              text: "older wording",
            },
            {
              kind: "revision",
              at: "2026-09-27T11:00:00.000Z",
              userId: "user-2",
              actorName: "Bob",
              revisionId: "rev-0-1",
              text: "",
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);

    expect(await screen.findByText("older wording")).toBeInTheDocument();
    expect(screen.getByText("emptyRevision")).toBeInTheDocument();
  });
});
