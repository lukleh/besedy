import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionSurface } from "@/components/correction/correction-surface";
import type { AudioPlayerProps } from "@/components/player/audio-player-types";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { ReloadSafetyProvider, useReloadSafety } from "@/contexts/reload-safety-context";
import { CorrectionDraftsProvider } from "@/contexts/correction-drafts-context";

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

const mocks = vi.hoisted(() => ({
  audioPlayer: vi.fn(),
  controls: {
    play: vi.fn(),
    pause: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    isPlayRequested: vi.fn(() => false),
  },
}));

vi.mock("@/components/player/audio-player", () => ({
  AudioPlayer: (props: AudioPlayerProps) => {
    mocks.audioPlayer(props);
    useImperativeHandle(props.ref, () => mocks.controls, []);
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

function ReloadSafetyStatus() {
  const { blocksAutomatic, blocksManual } = useReloadSafety();
  return <output data-testid="reload-safety">{JSON.stringify({ blocksAutomatic, blocksManual })}</output>;
}

function renderSurface(resume: { spanId: string; ordinal: number } | null, initialUserId = "user-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (visible = true, userId = initialUserId, workspace = WORKSPACE) => (
    <QueryClientProvider client={queryClient}>
      <ReloadSafetyProvider>
        <CorrectionDraftsProvider>
          <ReloadSafetyStatus />
          {visible && <CorrectionSurface
            key={`${workspace.id}:${userId}`}
            catalogId={CATALOG_ID}
            hash={HASH}
            userId={userId}
            workspace={workspace}
            resume={resume}
            guide={"# Návod\n\n- **Čísla** číslicemi"}
            onChanged={() => {}}
          />}
        </CorrectionDraftsProvider>
      </ReloadSafetyProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return {
    ...rendered,
    queryClient,
    showSurface: (visible = true, userId = initialUserId, workspace = WORKSPACE) => rendered.rerender(tree(visible, userId, workspace)),
  };
}

const fetchJsonMock = vi.mocked(fetchJson);

beforeEach(() => {
  sessionStorage.clear();
  fetchJsonMock.mockReset();
  mocks.audioPlayer.mockClear();
  mocks.controls.play.mockReset();
  mocks.controls.pause.mockReset();
  mocks.controls.getCurrentTime.mockReset().mockReturnValue(0);
  mocks.controls.isPlayRequested.mockReset().mockReturnValue(false);
});

function lastPlayerProps() {
  return mocks.audioPlayer.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/**
 * Drive the mocked player through a span as continuous playback at 1×, the
 * way a person who listened to it would have. Approving asks for that first.
 */
async function listenThrough(ordinal: number, { from = 0, to = 10 } = {}) {
  const props = lastPlayerProps() as {
    onPlayingChange: (playing: boolean) => void;
    onTimeUpdate: (time: number) => void;
  };
  const start = ordinal * 10;
  await act(async () => {
    props.onPlayingChange(true);
    for (let offset = from; offset <= to; offset += 1) props.onTimeUpdate(start + offset);
    props.onPlayingChange(false);
  });
}

describe("CorrectionSurface", () => {
  function serveDraftSpans(readPage = () => page(0, 2, 2)) {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) return readPage();
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });
  }

  it("selects another span while playing by pausing and positioning it without autoplay", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    expect(lastPlayerProps().sleepTimerEnabled).toBe(false);
    await act(async () => {
      (lastPlayerProps().onPlayingChange as (playing: boolean) => void)(true);
    });
    mocks.controls.pause.mockClear();

    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));

    expect(await screen.findByDisplayValue("machine 1")).toBeInTheDocument();
    expect(mocks.controls.pause).toHaveBeenCalledTimes(1);
    expect(lastPlayerProps()).toMatchObject({ seekTo: 10, playbackEnd: 20, autoPlayOnSeek: false });
    expect(mocks.controls.play).not.toHaveBeenCalled();
  });

  it("synchronizes the span toggle with media events, resumes in place and replays a finished span", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    const controls = within(screen.getByTestId("correction-span-audio"));
    const seekKey = lastPlayerProps().seekKey;
    await userEvent.click(controls.getByRole("button", { name: "playSpan" }));
    expect(mocks.controls.play).toHaveBeenLastCalledWith(10);

    mocks.controls.isPlayRequested.mockReturnValue(true);
    mocks.controls.getCurrentTime.mockReturnValue(4.25);
    await act(async () => {
      (lastPlayerProps().onPlayRequestChange as (requested: boolean) => void)(true);
      (lastPlayerProps().onPlayingChange as (playing: boolean) => void)(true);
    });
    await userEvent.click(controls.getByRole("button", { name: "pauseSpan" }));
    expect(mocks.controls.pause).toHaveBeenCalledTimes(1);

    mocks.controls.isPlayRequested.mockReturnValue(false);
    await act(async () => {
      (lastPlayerProps().onPlayRequestChange as (requested: boolean) => void)(false);
      (lastPlayerProps().onPlayingChange as (playing: boolean) => void)(false);
    });
    await userEvent.click(controls.getByRole("button", { name: "resumeSpan" }));
    expect(mocks.controls.play).toHaveBeenCalledTimes(2);
    expect(mocks.controls.play).toHaveBeenLastCalledWith(10);
    expect(lastPlayerProps().seekKey).toBe(seekKey);

    mocks.controls.getCurrentTime.mockReturnValue(10);
    await act(async () => {
      (lastPlayerProps().onPlayingChange as (playing: boolean) => void)(false);
    });
    await userEvent.click(controls.getByRole("button", { name: "playSpan" }));
    expect(lastPlayerProps()).toMatchObject({ seekTo: 0, playbackEnd: 10, autoPlayOnSeek: true });
  });

  it("shows a queued play as pausable and cancels it on a second span-button click", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    const controls = within(screen.getByTestId("correction-span-audio"));
    await userEvent.click(controls.getByRole("button", { name: "playSpan" }));
    // Queued for metadata or a reconnect: no play event yet, but a request.
    mocks.controls.isPlayRequested.mockReturnValue(true);
    await act(async () => {
      (lastPlayerProps().onPlayRequestChange as (requested: boolean) => void)(true);
    });
    const heard = within(screen.getByTestId("correction-heard"));
    expect(heard.getByRole("button", { name: "audio.pauseSpan" })).toBeInTheDocument();
    await userEvent.click(controls.getByRole("button", { name: "pauseSpan" }));
    expect(mocks.controls.play).toHaveBeenCalledTimes(1);
    expect(mocks.controls.pause).toHaveBeenCalledTimes(1);
  });

  it("offers resuming from the listening prompt too, after a pause mid-span", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    const heard = within(screen.getByTestId("correction-heard"));
    expect(heard.getByRole("button", { name: "audio.playSpan" })).toBeInTheDocument();
    mocks.controls.getCurrentTime.mockReturnValue(4.25);
    await act(async () => {
      (lastPlayerProps().onTimeUpdate as (time: number) => void)(4.25);
    });
    await userEvent.click(heard.getByRole("button", { name: "audio.resumeSpan" }));
    expect(mocks.controls.play).toHaveBeenLastCalledWith(10);
  });

  it("keeps the position and playback when the selected span is clicked again", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    const seekKey = lastPlayerProps().seekKey;
    await userEvent.click(screen.getByRole("button", { name: /machine 0/ }));
    expect(mocks.controls.pause).not.toHaveBeenCalled();
    expect(lastPlayerProps().seekKey).toBe(seekKey);
  });

  it("follows the playback time on a newly selected span", async () => {
    serveDraftSpans();
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await act(async () => {
      (lastPlayerProps().onTimeUpdate as (time: number) => void)(4.25);
    });
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");
    // The real player announces the applied seek; the mock does it by hand.
    await act(async () => {
      (lastPlayerProps().onTimeUpdate as (time: number) => void)(10);
    });
    const controls = within(screen.getByTestId("correction-span-audio"));
    expect(controls.getByRole("button", { name: "playSpan" })).toBeInTheDocument();
    await act(async () => {
      (lastPlayerProps().onTimeUpdate as (time: number) => void)(12);
    });
    expect(controls.getByRole("button", { name: "resumeSpan" })).toBeInTheDocument();
  });

  it("keeps an empty text draft and a comment when switching spans", async () => {
    serveDraftSpans();
    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "check this name");
    await userEvent.click(screen.getByText("machine 1"));
    expect(editor).toHaveValue("machine 1");
    expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("");
    await userEvent.click(screen.getByText("machine 0"));
    expect(editor).toHaveValue("");
    expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("check this name");
    expect(fetchJsonMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("restores drafts after remount and shows a conflict if the source revision changed", async () => {
    let currentPage = page(0, 2, 2);
    serveDraftSpans(() => currentPage);
    const first = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my correction");
    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "my note");
    first.unmount();
    currentPage = page(0, 2, 2, [span(0, { text: "someone else's correction", revisionId: "rev-0-2" }), span(1)]);
    renderSurface(null);
    expect(await screen.findByDisplayValue("my correction")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("someone else's correction");
    expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("my note");
  });

  it("does not expose another corrector's drafts", async () => {
    serveDraftSpans();
    const first = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "private unfinished correction");
    first.unmount();
    const second = renderSurface(null, "user-2");
    expect(await screen.findByDisplayValue("machine 0")).toBeInTheDocument();
    second.unmount();
    renderSurface(null);
    expect(await screen.findByDisplayValue("private unfinished correction")).toBeInTheDocument();
  });

  it("warns before unloading even when the draft is on another span", async () => {
    serveDraftSpans();
    const view = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.type(editor, " unfinished");
    await userEvent.click(screen.getByText("machine 1"));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    view.unmount();
    const afterUnmount = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });

  it("keeps drafts usable when session storage cannot be written", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    try {
      serveDraftSpans();
      renderSurface(null);
      const editor = await screen.findByDisplayValue("machine 0");
      await userEvent.type(editor, " unfinished");
      await userEvent.click(screen.getByText("machine 1"));
      await userEvent.click(screen.getByText("machine 0"));
      expect(editor).toHaveValue("machine 0 unfinished");
    } finally {
      storage.mockRestore();
    }
  });

  it.each(["QuotaExceededError", "SecurityError"])("keeps drafts and reload protection across surface remounts after %s", async (errorName) => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", errorName);
    });
    try {
      serveDraftSpans();
      const view = renderSurface(null);
      const editor = await screen.findByDisplayValue("machine 0");
      await userEvent.clear(editor);
      await userEvent.type(editor, "unfinished correction");
      await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "unfinished note");
      view.showSurface(false);
      expect(screen.queryByDisplayValue("unfinished correction")).not.toBeInTheDocument();
      const beforeUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(beforeUnload);
      expect(beforeUnload.defaultPrevented).toBe(true);
      expect(screen.getByTestId("reload-safety")).toHaveTextContent('{"blocksAutomatic":true,"blocksManual":true}');
      view.showSurface();
      expect(await screen.findByDisplayValue("unfinished correction")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("unfinished note");

      // The provider's memory fallback remains scoped after changing accounts or workspaces.
      view.showSurface(true, "user-2");
      expect(await screen.findByDisplayValue("machine 0")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("");
      view.showSurface(true, "user-1", { ...WORKSPACE, id: "ws-2" });
      expect(await screen.findByDisplayValue("machine 0")).toBeInTheDocument();
      view.showSurface();
      expect(await screen.findByDisplayValue("unfinished correction")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("unfinished note");
    } finally {
      storage.mockRestore();
    }
  });

  it.each(["shared correction", " shared correction "])("clears a draft matching the approved stored text: %j", async (draftText) => {
    let currentPage = page(0, 2, 2);
    serveDraftSpans(() => currentPage);
    const reads = fetchJsonMock.getMockImplementation()!;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return reads(input, init);
      expect(JSON.parse(String(init.body)).action).toBe("approve");
      return { spanId: "span-0", revisionId: "rev-0-2", text: "shared correction", state: "done", approverIds: ["user-1", "user-2"], disapproverIds: [], replayed: false };
    });
    const first = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, draftText);
    first.unmount();
    currentPage = page(0, 2, 2, [span(0, { text: "shared correction", revisionId: "rev-0-2" }), span(1)]);
    renderSurface(null);
    // A draft that differs from the stored text only in surrounding space is
    // no unsaved work; the editor shows the stored text.
    expect(await screen.findByDisplayValue("shared correction")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "approveAndContinue" }));
    await screen.findByDisplayValue("machine 1");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
    expect(screen.getByTestId("reload-safety")).toHaveTextContent('{"blocksAutomatic":false,"blocksManual":false}');
    expect(sessionStorage.getItem("besedy-correction-drafts:v1:user-1:ws-1")).toBeNull();
  });

  it.each(["", " plus newer typing"])("preserves an unsent comment and subsequent typing after plain approval: %j", async (newerText) => {
    sessionStorage.setItem("besedy-correction-drafts:v1:user-1:ws-1", JSON.stringify({
      "span-0": { text: { text: "machine 0", baseText: "older text", revisionId: "older-rev" }, comment: "unsent note" },
    }));
    serveDraftSpans();
    const reads = fetchJsonMock.getMockImplementation()!;
    let complete!: (value: unknown) => void;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return reads(input, init);
      return new Promise((resolve) => { complete = resolve; });
    });
    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "approveAndContinue" }));
    if (newerText) await userEvent.type(editor, newerText);
    complete({ spanId: "span-0", revisionId: "rev-0-1", text: "machine 0", state: "done", approverIds: ["user-1", "user-2"], disapproverIds: [], replayed: false });
    await screen.findByDisplayValue("machine 1");
    await userEvent.click(screen.getByText("machine 0"));
    expect(editor).toHaveValue(`machine 0${newerText}`);
    expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("unsent note");
  });

  it("clears only the submitted text draft after a successful save", async () => {
    let currentPage = page(0, 2, 2);
    serveDraftSpans(() => currentPage);
    const reads = fetchJsonMock.getMockImplementation()!;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return reads(input, init);
      currentPage = page(0, 2, 2, [span(0, { text: "saved correction", revisionId: "rev-0-2" }), span(1)]);
      return { spanId: "span-0", revisionId: "rev-0-2", text: "saved correction", state: "needs_second_approval", approverIds: ["user-1"], disapproverIds: [], replayed: false };
    });
    const first = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "saved correction");
    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "unsubmitted note");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "saveApproveAndContinue" }));
    await screen.findByDisplayValue("machine 1");
    first.unmount();
    renderSurface(null);
    expect(await screen.findByDisplayValue("saved correction")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("commentPlaceholder")).toHaveValue("unsubmitted note");
  });

  it("keeps newer typing when an earlier save finishes and advances", async () => {
    serveDraftSpans();
    const reads = fetchJsonMock.getMockImplementation()!;
    let complete!: (value: unknown) => void;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return reads(input, init);
      return new Promise((resolve) => { complete = resolve; });
    });
    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "submitted text");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "saveApproveAndContinue" }));
    await userEvent.type(editor, " plus newer typing");
    complete({ spanId: "span-0", revisionId: "rev-0-2", text: "submitted text", state: "needs_second_approval", approverIds: ["user-1"], disapproverIds: [], replayed: false });
    await screen.findByDisplayValue("machine 1");
    await userEvent.click(screen.getByText("machine 0"));
    expect(editor).toHaveValue("submitted text plus newer typing");
  });

  it("does not clear another span's comment when a submitted comment finishes", async () => {
    serveDraftSpans();
    const reads = fetchJsonMock.getMockImplementation()!;
    let complete!: (value: unknown) => void;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return reads(input, init);
      return new Promise((resolve) => { complete = resolve; });
    });
    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    const comment = screen.getByPlaceholderText("commentPlaceholder");
    await userEvent.type(comment, "submitted note");
    await userEvent.click(screen.getByRole("button", { name: "addComment" }));
    await userEvent.click(screen.getByText("machine 1"));
    await userEvent.type(comment, "another span's note");
    complete({ id: "comment-1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "addComment" })).toBeEnabled());
    expect(comment).toHaveValue("another span's note");
    await userEvent.click(screen.getByText("machine 0"));
    expect(comment).toHaveValue("");
    await userEvent.click(screen.getByText("machine 1"));
    expect(comment).toHaveValue("another span's note");
  });

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
    await listenThrough(0);
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

    await listenThrough(0);
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

  // A person's own save is not a conflict, including when the server
  // canonicalizes the submitted text. Visible on the last span, where nothing
  // advances.
  it.each([
    ["my text", "my text"],
    ["my  text", "my text"],
  ])("settles an own save of %j as %j", async (draftText, storedText) => {
    let spansServed = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) {
        spansServed += 1;
        return spansServed === 1
          ? page(0, 1, 1)
          : page(0, 1, 1, [span(0, { text: storedText, revisionId: "rev-0-2", isEdited: true })]);
      }
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return {
          spanId: "span-0",
          revisionId: "rev-0-2",
          text: storedText,
          state: "needs_second_approval",
          approverIds: ["user-1"],
          disapproverIds: [],
          replayed: false,
        };
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);

    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, draftText);
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "saveApproveAndContinue" }));

    await waitFor(() => expect(spansServed).toBeGreaterThan(1));
    expect(editor).toHaveValue(storedText);
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    // The baseline moved with the save: the text is no longer an edit.
    expect(screen.getByRole("button", { name: "approveAndContinue" })).toBeInTheDocument();
  });

  // A clean draft follows each revision in turn. The baseline has to move
  // with it, or the second revision would be measured against the first and
  // flagged as unsaved work.
  it("follows successive clean revisions without flagging a conflict", async () => {
    let spansServed = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/spans?offset=0")) {
        spansServed += 1;
        const text = spansServed === 1 ? "machine 0" : spansServed === 2 ? "second" : "third";
        return page(0, 1, 1, [span(0, { text, revisionId: `rev-0-${spansServed}` })]);
      }
      if (url.endsWith("/comments") && init?.method === "POST") {
        return { id: `comment-${spansServed}`, createdAt: "2026-09-28T10:00:00.000Z" };
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "one");
    await userEvent.click(screen.getByRole("button", { name: "addComment" }));
    expect(await screen.findByDisplayValue("second")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("commentPlaceholder"), "two");
    await userEvent.click(screen.getByRole("button", { name: "addComment" }));
    expect(await screen.findByDisplayValue("third")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
  });

  // "Next to resolve" has to reach a segment that is not in the loaded pages,
  // and prepare it without starting playback.
  it("jumps to the next segment that wants this person, loading its page", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/next?after=")) return { next: { spanId: "span-230", ordinal: 230 } };
      if (url.includes("/spans?offset=200")) return page(200, 50, 250);
      if (url.includes("/spans?offset=0")) return page(0, 200, 250);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    await userEvent.click(screen.getByTestId("correction-next-open"));

    expect(await screen.findByDisplayValue("machine 230")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastPlayerProps().autoPlayOnSeek).toBe(false);
      expect(lastPlayerProps().seekTo).toBe(2300);
    });
  });

  it("jumps from the strip to a segment without playing it", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) {
        return {
          workspaceId: WORKSPACE.id,
          spans: Array.from({ length: 3 }, (_, i) => ({
            spanId: `span-${i}`,
            ordinal: i,
            startSeconds: i * 10,
            endSeconds: i * 10 + 10,
            state: i === 2 ? "needs_attention" : "done",
            wantsMe: false,
          })),
        };
      }
      if (url.includes("/spans?offset=0")) return page(0, 3, 3);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await screen.findByTestId("correction-strip");

    // The last bucket belongs to the disputed segment at the end.
    const buckets = screen.getByTestId("correction-strip").querySelectorAll("button");
    await userEvent.click(buckets[buckets.length - 1]);

    expect(await screen.findByDisplayValue("machine 2")).toBeInTheDocument();
    await waitFor(() => expect(lastPlayerProps().autoPlayOnSeek).toBe(false));
  });

  // The jump buttons count from the strip and ask the server for the next
  // span of their kind after the one on screen; the list itself stays whole.
  it("jumps to the next segment of a kind, counted from the strip", async () => {
    const urls: string[] = [];
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/strip")) {
        return {
          workspaceId: WORKSPACE.id,
          spans: Array.from({ length: 3 }, (_, i) => ({
            spanId: `span-${i}`,
            ordinal: i,
            startSeconds: i * 10,
            endSeconds: i * 10 + 10,
            state: i === 2 ? "needs_attention" : "done",
            wantsMe: i === 2,
          })),
        };
      }
      if (url.includes("/next?")) return { next: { spanId: "span-2", ordinal: 2 } };
      if (url.includes("/spans?offset=0")) return page(0, 3, 3);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    const attention = screen.getByTestId("correction-jump-needs_attention");
    await waitFor(() => expect(attention).toHaveTextContent("1"));
    expect(screen.getByTestId("correction-jump-not_reviewed")).toBeDisabled();

    await userEvent.click(attention);

    expect(await screen.findByDisplayValue("machine 2")).toBeInTheDocument();
    expect(urls.some((url) => url.includes("/next?after=0&kind=needs_attention"))).toBe(true);
    // Every segment is still listed: the jump did not narrow the list.
    expect(screen.getByText("machine 1")).toBeInTheDocument();
  });

  // Nothing about finding work may move the person off the segment they are
  // typing into: the list never drops it, so the draft survives a refresh.
  it("keeps the draft when the list refreshes under it", async () => {
    let refreshed = false;
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return refreshed
          ? page(0, 3, 3, [span(0), span(1, { state: "done" }), span(2)])
          : page(0, 3, 3);
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    const { queryClient } = renderSurface({ spanId: "span-1", ordinal: 1 });
    const editor = await screen.findByDisplayValue("machine 1");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my wording");

    refreshed = true;
    await queryClient.invalidateQueries({ queryKey: ["correction-spans"] });

    await waitFor(() => expect(screen.getAllByText("stateDone").length).toBeGreaterThan(0));
    expect(screen.getByDisplayValue("my wording")).toBeInTheDocument();
  });

  // An approval made without listening is stored but never trains a model
  // (ADR 0012), and the person would only learn that at export. The button
  // waits for the listening and says how much is still missing.
  it("keeps approve disabled until most of the span was heard", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 1, 1);
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    const approve = screen.getByTestId("correction-approve");
    expect(approve).toBeDisabled();
    expect(screen.getByTestId("correction-heard")).toHaveAttribute("data-heard", "0.00");
    expect(screen.getByText("listenBeforeApprove")).toBeInTheDocument();
    // Disapproving never waits for playback.
    expect(screen.getByRole("button", { name: "disapprove" })).toBeEnabled();

    // Half of the span is not enough.
    await listenThrough(0, { from: 0, to: 5 });
    expect(approve).toBeDisabled();
    expect(screen.getByTestId("correction-heard")).toHaveAttribute("data-heard", "0.50");

    await listenThrough(0, { from: 5, to: 10 });
    expect(approve).toBeEnabled();
    expect(screen.getByTestId("correction-heard")).toHaveAttribute("data-heard", "1.00");
    expect(screen.queryByText("listenBeforeApprove")).not.toBeInTheDocument();
    expect(fetchJsonMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  // Clicking another segment used to replace the draft with that segment's
  // text. A half-written correction has to wait where it was left, be
  // findable in the list, and come back when the person returns.
  it("keeps an unsaved draft while the person works elsewhere and restores it on return", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 3, 3);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "half written");

    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");
    const first = screen.getByRole("button", { name: /machine 0/ });
    expect(first).toHaveTextContent("unsavedDraft");
    expect(screen.getByRole("button", { name: /machine 1/ })).not.toHaveTextContent("unsavedDraft");

    await userEvent.click(first);
    expect(await screen.findByDisplayValue("half written")).toBeInTheDocument();
    expect(screen.queryByText("unsavedDraft")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    // Restored as an edit: the primary action saves it.
    expect(screen.getByRole("button", { name: "saveApproveAndContinue" })).toBeInTheDocument();
  });

  // Somebody else may save the segment while the draft waits. Returning to it
  // then shows the draft as a conflict, like a refresh under an open draft.
  it("flags a restored draft when the stored text moved while it waited", async () => {
    let moved = false;
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return moved
          ? page(0, 2, 2, [span(0, { text: "their text", revisionId: "rev-0-2", isEdited: true }), span(1)])
          : page(0, 2, 2);
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    const { queryClient } = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");

    moved = true;
    await queryClient.invalidateQueries({ queryKey: ["correction-spans"] });
    await waitFor(() => expect(screen.getByRole("button", { name: /their text/ })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /their text/ }));
    expect(await screen.findByDisplayValue("my text")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text");
  });

  // A draft flagged once keeps the flag after more typing, a trip to another
  // segment and back: otherwise approving would overwrite the newer text
  // without the person seeing it.
  it("keeps a flagged conflict when the person edits, leaves and returns", async () => {
    let moved = false;
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return moved
          ? page(0, 2, 2, [span(0, { text: "their text", revisionId: "rev-0-2", isEdited: true }), span(1)])
          : page(0, 2, 2);
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    const { queryClient } = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    moved = true;
    await queryClient.invalidateQueries({ queryKey: ["correction-spans"] });
    await waitFor(() => expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text"));

    await userEvent.type(editor, " and more");
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");
    await userEvent.click(screen.getByRole("button", { name: /their text/ }));

    expect(await screen.findByDisplayValue("my text and more")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text");
  });

  // Advancing after a save used to run before the refetched list rendered,
  // so the reconciliation saw the old baseline and stashed the span that had
  // just been saved as unsaved work.
  it("does not stash the span it just saved when it advances", async () => {
    let spansServed = 0;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        spansServed += 1;
        return spansServed === 1
          ? page(0, 2, 2)
          : page(0, 2, 2, [span(0, { text: "my text", revisionId: "rev-0-2", isEdited: true }), span(1)]);
      }
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return {
          spanId: "span-0",
          revisionId: "rev-0-2",
          text: "my text",
          state: "needs_second_approval",
          approverIds: ["user-1"],
          disapproverIds: [],
          replayed: false,
        };
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "saveApproveAndContinue" }));

    await screen.findByDisplayValue("machine 1");
    expect(screen.queryByText("unsavedDraft")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /my text/ })).not.toHaveTextContent("unsavedDraft");
  });

  // A stashed draft whose wording the span now carries is not unsaved work:
  // the person's own save landed, or somebody saved the same text.
  it("drops a stashed draft that matches the stored text instead of flagging a conflict", async () => {
    let moved = false;
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return moved
          ? page(0, 2, 2, [span(0, { text: "my text", revisionId: "rev-0-2", isEdited: true }), span(1)])
          : page(0, 2, 2);
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    const { queryClient } = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my text");
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");

    moved = true;
    await queryClient.invalidateQueries({ queryKey: ["correction-spans"] });
    await waitFor(() => expect(screen.getByRole("button", { name: /my text/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /my text/ }));

    expect(await screen.findByDisplayValue("my text")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    expect(screen.queryByText("unsavedDraft")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "approveAndContinue" })).toBeInTheDocument();
  });

  // The gate must follow the span in the same render as the selection, or
  // the approve button is briefly enabled with the previous span's listening.
  it("disables approve for the next span in the very render it is selected", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 2, 2);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await listenThrough(0);
    expect(screen.getByTestId("correction-approve")).toBeEnabled();

    const seen: boolean[] = [];
    const observer = new MutationObserver(() => {
      const button = screen.queryByTestId("correction-approve");
      if (button) seen.push((button as HTMLButtonElement).disabled);
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    await screen.findByDisplayValue("machine 1");
    observer.disconnect();

    expect(screen.getByTestId("correction-approve")).toBeDisabled();
    // Once the editor shows span 1, no observed state had the button enabled.
    const firstDisabled = seen.indexOf(true);
    expect(firstDisabled).toBeGreaterThanOrEqual(0);
    expect(seen.slice(firstDisabled)).not.toContain(false);
  });

  // A draft the person no longer wants goes back to the stored text, which
  // also clears the unsaved-work state a stashed draft would otherwise keep.
  it("discards a draft back to the stored text", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 1, 1);
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "typo");
    await userEvent.click(screen.getByTestId("correction-discard-draft"));

    expect(editor).toHaveValue("machine 0");
    expect(screen.queryByTestId("correction-discard-draft")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("besedy-correction-drafts:v1:user-1:ws-1")).toBeNull();
    expect(screen.getByRole("button", { name: "approveAndContinue" })).toBeInTheDocument();
  });

  // Ctrl+Enter below the threshold must not approve, and must not pass silently.
  it("refuses Ctrl+Enter before the span was heard and sends nothing", async () => {
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 1, 1);
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return {
          spanId: "span-0",
          revisionId: "rev-0-1",
          text: "machine 0",
          state: "needs_second_approval",
          approverIds: ["user-1"],
          disapproverIds: [],
          replayed: false,
        };
      }
      if (/\/spans\/span-0$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(fetchJsonMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    await listenThrough(0);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(fetchJsonMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    );
  });
});
