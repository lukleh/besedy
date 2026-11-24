import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionSurface, nextWaitingSpan } from "@/components/correction/correction-surface";
import type { AudioPlayerProps } from "@/components/player/audio-player-types";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { ReloadSafetyProvider, useReloadSafety } from "@/contexts/reload-safety-context";
import { CorrectionDraftsProvider } from "@/contexts/correction-drafts-context";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
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
  useToast: () => ({ toast: mocks.toast }),
}));

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
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
    return <div data-testid="audio-player">{props.renderControls?.({
      volume: 1, isMuted: false, isBuffering: false, isReconnecting: false, hasError: false,
      seek: vi.fn(), setVolume: vi.fn(), toggleMute: vi.fn(), retry: vi.fn(),
    })}</div>;
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
  publicationId: null,
  canUnpublish: false,
  unpublishPending: false,
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
    // Somebody else has been through it, so it can be disapproved.
    state: "needs_second_approval",
    approverIds: ["user-9"],
    disapproverIds: [],
    commentCount: 0,
    lastEditedById: null,
    lastEditedAt: null,
    speechRegions: [[ordinal * 160000, (ordinal + 1) * 160000]],
    machineWords: [],
    flags: [],
    ...overrides,
  };
}

function page(offset: number, count: number, total: number, spans = Array.from({ length: count }, (_, i) => span(offset + i))) {
  return { workspaceId: WORKSPACE.id, offset, limit: 200, total, spans };
}

function ReloadSafetyStatus() {
  const { blocksAutomatic } = useReloadSafety();
  return <output data-testid="reload-safety">{JSON.stringify({ blocksAutomatic })}</output>;
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

// The shared setup replaces localStorage with bare mocks; drafts need one that remembers.
const stored = new Map<string, string>();

beforeEach(() => {
  window.history.replaceState(null, "", `/catalog/${CATALOG_ID}/recording/${HASH}/correction`);
  stored.clear();
  vi.mocked(localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => void stored.set(key, value));
  vi.mocked(localStorage.removeItem).mockImplementation((key) => void stored.delete(key));
  fetchJsonMock.mockReset();
  mocks.audioPlayer.mockClear();
  mocks.toast.mockReset();
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

/** The note opens with "Disapprove"; open it unless a kept note already did. */
async function noteBox() {
  if (!screen.queryByPlaceholderText("commentPlaceholder")) {
    await userEvent.click(screen.getByTestId("correction-disapprove-open"));
  }
  return screen.getByPlaceholderText("commentPlaceholder");
}

async function disapproveButton() {
  if (!screen.queryByTestId("correction-disapprove")) {
    await userEvent.click(screen.getByTestId("correction-disapprove-open"));
  }
  return screen.getByTestId("correction-disapprove");
}

describe("CorrectionSurface", () => {
  function serveDraftSpans(readPage = () => page(0, 2, 2)) {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return {
        workspaceId: WORKSPACE.id,
        spans: readPage().spans.map((span) => ({
          spanId: span.id, ordinal: span.ordinal,
          startSeconds: span.startSeconds, endSeconds: span.endSeconds,
          state: span.state, wantsMe: true,
        })),
      };
      if (url.includes("/spans?offset=0")) return readPage();
      const linked = new URL(url, "http://test").searchParams.get("segment");
      if (linked !== null) return linkedPage(readPage(), linked);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });
  }

  // The server answers a linked segment with the page holding it.
  function linkedPage(served: ReturnType<typeof page>, spanId: string) {
    if (served.spans.some((span) => span.id === spanId)) return served;
    throw new ApiError("Span not found in this workspace", 404, { code: "SPAN_NOT_FOUND" });
  }

  it("opens a shared segment beyond the first page in one request, without waiting for the strip", async () => {
    window.history.replaceState(null, "", `${window.location.pathname}?segment=span-230&filter=mine#notes`);
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return new Promise(() => {});
      if (url.includes("/spans?segment=span-230")) return page(200, 50, 250);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });
    renderSurface({ spanId: "span-0", ordinal: 0 });
    expect(await screen.findByDisplayValue("machine 230")).toBeInTheDocument();
    expect(lastPlayerProps()).toMatchObject({ seekTo: 2300, autoPlayOnSeek: false });
    await waitFor(() => expect(window.location.search).toBe("?filter=mine"));
    expect(window.location.hash).toBe("#notes");
    expect(fetchJsonMock.mock.calls.some(([url]) => String(url).includes("/spans?offset="))).toBe(false);
  });

  it("offers a retry and the resume position when a linked segment's page fails to load", async () => {
    window.history.replaceState(null, "", `${window.location.pathname}?segment=span-1`);
    let fail = true;
    serveDraftSpans();
    const reads = fetchJsonMock.getMockImplementation()!;
    fetchJsonMock.mockImplementation(async (input, init) => {
      if (fail && String(input).includes("/spans?segment=")) throw new ApiError("Unavailable", 503);
      return reads(input, init);
    });
    renderSurface({ spanId: "span-0", ordinal: 0 });
    expect(await screen.findByText("segmentLinkLoadFailed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "segmentLinkResume" })).toBeInTheDocument();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "segmentLinkRetry" }));
    expect(await screen.findByDisplayValue("machine 1")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("explains a missing link and only opens the resume segment after explicit recovery", async () => {
    window.history.replaceState(null, "", `${window.location.pathname}?segment=missing`);
    serveDraftSpans();
    renderSurface({ spanId: "span-1", ordinal: 1 });
    expect(await screen.findByText("segmentLinkMissing")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "segmentLinkRetry" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?segment=missing");
    expect(fetchJsonMock.mock.calls.some(([url]) => String(url).includes("/spans?offset="))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "segmentLinkResume" }));
    expect(await screen.findByDisplayValue("machine 1")).toBeInTheDocument();
    expect(lastPlayerProps().autoPlayOnSeek).toBe(false);
  });

  it.each([false, true])("shares a canonical segment URL by copying it on a desktop (copy fails: %s)", async (fail) => {
    window.history.replaceState(null, "", `${window.location.pathname}?backTo=%2Fsettings&filter=mine#notes`);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = fail ? vi.fn().mockRejectedValue(new Error("unavailable")) : vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      serveDraftSpans();
      renderSurface(null);
      await screen.findByDisplayValue("machine 0");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "shareSegment" })); });
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/catalog/${CATALOG_ID}/recording/${HASH}/correction?segment=span-0`);
      expect(mocks.toast).toHaveBeenCalledWith(fail
        ? { description: "segmentLinkCopyFailed", variant: "destructive" }
        : { description: "segmentLinkCopied" });
      expect(window.location.search).toContain("backTo=");
      expect(window.location.hash).toBe("#notes");
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("opens the system share sheet on a touch device without a copy toast", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList,
    });
    try {
      serveDraftSpans();
      renderSurface(null);
      await screen.findByDisplayValue("machine 0");
      await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
      await screen.findByDisplayValue("machine 1");
      expect(window.location.search).toBe("");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "shareSegment" })); });
      expect(share).toHaveBeenCalledWith({
        url: `${window.location.origin}/catalog/${CATALOG_ID}/recording/${HASH}/correction?segment=span-1`,
      });
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "share");
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("brings the selected span into view by scrolling only the segment list", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      serveDraftSpans(() => page(0, 3, 3));
      renderSurface(null);
      await screen.findByDisplayValue("machine 0");
      const item = screen.getByRole("button", { name: /machine 2/ });
      const list = item.closest("aside")!;
      vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 100));
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 130, 300, 30));

      await userEvent.click(item);
      expect(await screen.findByDisplayValue("machine 2")).toBeInTheDocument();
      expect(list.scrollTop).toBe(60);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

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
    await userEvent.type((await noteBox()), "check this name");
    await userEvent.click(screen.getByText("machine 1"));
    expect(editor).toHaveValue("machine 1");
    expect((await noteBox())).toHaveValue("");
    await userEvent.click(screen.getByText("machine 0"));
    expect(editor).toHaveValue("");
    expect((await noteBox())).toHaveValue("check this name");
    expect(fetchJsonMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("restores drafts after remount and shows a conflict if the source revision changed", async () => {
    let currentPage = page(0, 2, 2);
    serveDraftSpans(() => currentPage);
    const first = renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my correction");
    await userEvent.type((await noteBox()), "my note");
    first.unmount();
    currentPage = page(0, 2, 2, [span(0, { text: "someone else's correction", revisionId: "rev-0-2" }), span(1)]);
    renderSurface(null);
    expect(await screen.findByDisplayValue("my correction")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("someone else's correction");
    expect((await noteBox())).toHaveValue("my note");
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

  // Drafts are stored, so nothing holds a reload or an app update back.
  it("does not hold back a reload or an update for a draft", async () => {
    serveDraftSpans();
    renderSurface(null);
    const editor = await screen.findByDisplayValue("machine 0");
    await userEvent.type(editor, " unfinished");
    await userEvent.click(screen.getByText("machine 1"));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
    expect(screen.getByTestId("reload-safety")).toHaveTextContent('{"blocksAutomatic":false}');
    expect(localStorage.getItem("besedy-correction-drafts:v1:user-1:ws-1")).toContain("machine 0 unfinished");
  });

  it("keeps drafts usable when browser storage cannot be written", async () => {
    const storage = vi.mocked(localStorage.setItem).mockImplementation(() => {
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

  it.each(["QuotaExceededError", "SecurityError"])("keeps drafts across surface remounts after %s", async (errorName) => {
    const storage = vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException("Storage unavailable", errorName);
    });
    try {
      serveDraftSpans();
      const view = renderSurface(null);
      const editor = await screen.findByDisplayValue("machine 0");
      await userEvent.clear(editor);
      await userEvent.type(editor, "unfinished correction");
      await userEvent.type((await noteBox()), "unfinished note");
      view.showSurface(false);
      expect(screen.queryByDisplayValue("unfinished correction")).not.toBeInTheDocument();
      view.showSurface();
      expect(await screen.findByDisplayValue("unfinished correction")).toBeInTheDocument();
      expect((await noteBox())).toHaveValue("unfinished note");

      // The provider's memory fallback remains scoped after changing accounts or workspaces.
      view.showSurface(true, "user-2");
      expect(await screen.findByDisplayValue("machine 0")).toBeInTheDocument();
      expect((await noteBox())).toHaveValue("");
      view.showSurface(true, "user-1", { ...WORKSPACE, id: "ws-2" });
      expect(await screen.findByDisplayValue("machine 0")).toBeInTheDocument();
      view.showSurface();
      expect(await screen.findByDisplayValue("unfinished correction")).toBeInTheDocument();
      expect((await noteBox())).toHaveValue("unfinished note");
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
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    await screen.findByDisplayValue("machine 1");
    expect(localStorage.getItem("besedy-correction-drafts:v1:user-1:ws-1")).toBeNull();
  });

  it.each(["", " plus newer typing"])("preserves typing that follows a plain approval: %j", async (newerText) => {
    localStorage.setItem("besedy-correction-drafts:v1:user-1:ws-1", JSON.stringify({
      "span-0": { text: { text: "machine 0", baseText: "older text", revisionId: "older-rev" } },
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
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    if (newerText) await userEvent.type(editor, newerText);
    complete({ spanId: "span-0", revisionId: "rev-0-1", text: "machine 0", state: "done", approverIds: ["user-1", "user-2"], disapproverIds: [], replayed: false });
    await screen.findByDisplayValue("machine 1");
    await userEvent.click(screen.getByText("machine 0"));
    expect(editor).toHaveValue(`machine 0${newerText}`);
  });

  it("clears the submitted text draft and the note sent with it after a successful save", async () => {
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
    await userEvent.type((await noteBox()), "note sent with the text");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "saveAndApprove" }));
    await screen.findByDisplayValue("machine 1");
    first.unmount();
    renderSurface(null);
    expect(await screen.findByDisplayValue("saved correction")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    expect((await noteBox())).toHaveValue("");
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
    await userEvent.click(screen.getByRole("button", { name: "saveAndApprove" }));
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
    await userEvent.type(await noteBox(), "submitted note");
    await userEvent.click(screen.getByRole("button", { name: "sendNote" }));
    await userEvent.click(screen.getByText("machine 1"));
    // The note box belongs to the panel, which closes on a span without a note.
    await userEvent.type(await noteBox(), "another span's note");
    complete({ id: "comment-1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "sendNote" })).toBeEnabled());
    expect(await noteBox()).toHaveValue("another span's note");
    await userEvent.click(screen.getByText("machine 0"));
    expect(await noteBox()).toHaveValue("");
    await userEvent.click(screen.getByText("machine 1"));
    expect(await noteBox()).toHaveValue("another span's note");
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
    await userEvent.click(screen.getByRole("button", { name: "saveAndApprove" }));

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
    await userEvent.type((await noteBox()), "a note");
    await userEvent.click(screen.getByRole("button", { name: "sendNote" }));

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
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
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

  it("keeps the selected span's conflict when an earlier approval succeeds", async () => {
    let moved = false;
    let resolveApprove: (value: unknown) => void = () => {};
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return moved
          ? page(0, 2, 2, [span(0), span(1, { text: "their text", revisionId: "rev-1-2", isEdited: true })])
          : page(0, 2, 2);
      }
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveApprove = resolve;
        });
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    const { queryClient } = renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    const editor = await screen.findByDisplayValue("machine 1");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my draft");
    moved = true;
    await queryClient.invalidateQueries({ queryKey: ["correction-spans"] });
    await waitFor(() => expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text"));

    resolveApprove({
      spanId: "span-0",
      revisionId: "rev-0-1",
      text: "machine 0",
      state: "needs_second_approval",
      approverIds: ["user-1"],
      disapproverIds: [],
      replayed: false,
    });

    await waitFor(() => expect(screen.getByTestId("correction-discard-draft")).not.toBeDisabled());
    expect(editor).toHaveValue("my draft");
    expect(screen.getByTestId("conflict-current-text")).toHaveTextContent("their text");
  });

  it("does not flag the selected span when an earlier command conflicts", async () => {
    let rejectApprove: (error: Error) => void = () => {};
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 2, 2);
      if (/\/spans\/span-0$/.test(url) && init?.method === "POST") {
        return new Promise((_resolve, reject) => {
          rejectApprove = reject;
        });
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await listenThrough(0);
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    await userEvent.click(screen.getByRole("button", { name: /machine 1/ }));
    const editor = await screen.findByDisplayValue("machine 1");
    await userEvent.clear(editor);
    await userEvent.type(editor, "my draft");

    rejectApprove(new ApiError("conflict", 409, { code: "REVISION_CONFLICT" }));

    await waitFor(() => expect(screen.getByTestId("correction-discard-draft")).not.toBeDisabled());
    expect(editor).toHaveValue("my draft");
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith({ description: "conflict", variant: "destructive" });
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

    await userEvent.click(await disapproveButton());
    await waitFor(() => expect(attempts).toBe(1));
    await userEvent.click(await disapproveButton());
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
    await userEvent.click(screen.getByRole("button", { name: "saveAndApprove" }));

    await waitFor(() => expect(spansServed).toBeGreaterThan(1));
    expect(editor).toHaveValue(storedText);
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
    // The baseline moved with the save: the text is no longer an edit.
    expect(screen.getByRole("button", { name: "approve" })).toBeInTheDocument();
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

    await userEvent.type((await noteBox()), "one");
    await userEvent.click(screen.getByRole("button", { name: "sendNote" }));
    expect(await screen.findByDisplayValue("second")).toBeInTheDocument();

    await userEvent.type((await noteBox()), "two");
    await userEvent.click(screen.getByRole("button", { name: "sendNote" }));
    expect(await screen.findByDisplayValue("third")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-current-text")).not.toBeInTheDocument();
  });

  // Approving moves on to the next segment still waiting for this person,
  // not to the next one in the recording, and plays it.
  it("moves on to the next waiting segment after an approval, loading its page, and plays it", async () => {
    const waiting = new Set([0, 230]);
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        waiting.delete(0);
        return { spanId: "span-0", revisionId: "rev-0", text: "machine 0", state: "needs_second_approval", approverIds: ["user-1"], disapproverIds: [], replayed: false };
      }
      if (url.endsWith("/strip")) {
        return {
          workspaceId: WORKSPACE.id,
          spans: Array.from({ length: 250 }, (_, i) => ({
            spanId: `span-${i}`,
            ordinal: i,
            startSeconds: i * 10,
            endSeconds: i * 10 + 10,
            state: waiting.has(i) ? "not_reviewed" : "done",
            wantsMe: waiting.has(i),
          })),
        };
      }
      if (url.includes("/spans?offset=200")) return page(200, 50, 250);
      if (url.includes("/spans?offset=0")) return page(0, 200, 250);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    expect(await screen.findByTestId("correction-waiting-count")).toHaveTextContent("waitingForYou");
    await listenThrough(0);

    await userEvent.click(screen.getByRole("button", { name: "approve" }));

    expect(await screen.findByDisplayValue("machine 230")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastPlayerProps().autoPlayOnSeek).toBe(true);
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

  it("picks the next waiting segment after the decided one, wrapping round and never itself", () => {
    const strip = [0, 1, 2, 3].map((i) => ({
      spanId: `span-${i}`, ordinal: i, startSeconds: i * 10, endSeconds: i * 10 + 10,
      state: "not_reviewed" as const, wantsMe: i === 1 || i === 3,
    }));
    expect(nextWaitingSpan(strip, { spanId: "span-1", ordinal: 1 })?.spanId).toBe("span-3");
    expect(nextWaitingSpan(strip, { spanId: "span-3", ordinal: 3 })?.spanId).toBe("span-1");
    expect(nextWaitingSpan([strip[0], strip[1]], { spanId: "span-1", ordinal: 1 })).toBeNull();
  });

  // "Disapprove the text" sends the note first, then the objection, and a
  // disputed segment names who objects and what they wrote above the editor.
  it("sends the note with a disapproval and explains a disputed segment", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/comments")) return { id: "comment-1" };
        return { spanId: "span-0", revisionId: "rev-0", text: "machine 0", state: "needs_attention", approverIds: [], disapproverIds: ["user-1"], replayed: false };
      }
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return page(0, 2, 2, [span(0), span(1, { state: "needs_attention", disapproverIds: ["user-2"] })]);
      }
      if (/\/spans\/span-1$/.test(url)) {
        return {
          spanId: "span-1",
          history: [
            { kind: "revision", at: "2026-01-01T10:00:00Z", userId: null, revisionId: span(1).revisionId, actorName: null, text: "machine 1" },
            { kind: "comment", at: "2026-01-01T11:00:00Z", userId: "user-2", revisionId: span(1).revisionId, actorName: "Jana", body: "chybí slovo" },
            { kind: "decision", at: "2026-01-01T11:00:01Z", userId: "user-2", revisionId: span(1).revisionId, actorName: "Jana", decision: "DISAPPROVE" },
          ],
        };
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    expect(screen.queryByTestId("correction-objection")).not.toBeInTheDocument();
    await userEvent.type(await noteBox(), "nerozumím konci");
    await userEvent.click(await disapproveButton());

    // The decision moves on to the next segment, which is disputed by somebody else.
    expect(await screen.findByDisplayValue("machine 1")).toBeInTheDocument();
    expect(posts.map((post) => post.url.split("/").at(-1))).toEqual(["comments", "span-0"]);
    expect(posts[0].body.body).toBe("nerozumím konci");
    expect(posts[1].body.action).toBe("disapprove");
    const objection = await screen.findByTestId("correction-objection");
    expect(objection).toHaveTextContent("disapprovedBy");
    expect(objection).toHaveTextContent("chybí slovo");
    // The history speaks the interface language and names the machine import.
    const history = screen.getByTestId("correction-history");
    expect(history).toHaveTextContent("machineTranscript");
    expect(history).toHaveTextContent("historyKind.DISAPPROVE");
  });

  // A note written beside the text is not left behind by the main button.
  // The decision goes first: a refused one leaves the note a draft, and a
  // stored one gives the note the revision it settled.
  it("sends a written note once the submission is stored", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let refuse = true;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/comments")) return { id: "comment-1" };
        if (refuse) throw new ApiError("locked", 409, { code: "WORKSPACE_LOCKED" });
        return { spanId: "span-0", revisionId: "rev-0-2", text: "machine 0", state: "done", approverIds: ["user-9", "user-1"], disapproverIds: [], replayed: false };
      }
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 2, 2, [span(0), span(1)]);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await userEvent.type(await noteBox(), "ke konci není rozumět");
    await listenThrough(0);
    await userEvent.click(screen.getByTestId("correction-approve"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.action).toBe("approve");
    expect(await noteBox()).toHaveValue("ke konci není rozumět");

    refuse = false;
    await waitFor(() => expect(screen.getByTestId("correction-approve")).toBeEnabled());
    await userEvent.click(screen.getByTestId("correction-approve"));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map((post) => post.url.split("/").at(-1))).toEqual(["span-0", "span-0", "comments"]);
    expect(posts[2].body).toMatchObject({ body: "ke konci není rozumět", revisionId: "rev-0-2" });
  });

  // Until a flag change is stored and the list refreshed, the span's flags
  // on screen are stale, so the submission waits for them.
  it("holds the submission while a flag change is on its way", async () => {
    const flagged = span(0, {
      flags: [{ kind: "UNCLEAR", languageCode: null, comment: null, actorKey: "user:user-1", setAt: "2026-01-01T10:00:00Z" }],
    });
    let finishFlag!: (value: unknown) => void;
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/flags")) {
        return new Promise((resolve) => { finishFlag = resolve; });
      }
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) return page(0, 2, 2, [flagged, span(1)]);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "span-0", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    await listenThrough(0);
    const submit = screen.getByTestId("correction-approve");
    expect(submit).toBeEnabled();
    await userEvent.click(await screen.findByTestId("correction-flag-UNCLEAR"));
    expect(submit).toBeDisabled();
    // Closing the panel meanwhile would lose that wait, so it stays open.
    await userEvent.click(screen.getByTestId("correction-flags-toggle"));
    expect(screen.getByTestId("correction-flag-UNCLEAR")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await act(async () => { finishFlag({}); });
    await waitFor(() => expect(submit).toBeEnabled());
  });

  // Disapproving needs a first pass to disapprove: untouched machine text is
  // corrected or flagged, and the flags open from their own button.
  it("offers Disapprove only as the second pass, and flags on request", async () => {
    fetchJsonMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/strip")) return { workspaceId: WORKSPACE.id, spans: [] };
      if (url.includes("/spans?offset=0")) {
        return page(0, 4, 4, [
          span(0, { state: "not_reviewed", approverIds: [] }),
          span(1, { state: "needs_second_approval", approverIds: ["user-1"] }),
          span(2, { state: "needs_second_approval", approverIds: ["user-9"] }),
          span(3, { state: "done", approverIds: ["user-8", "user-9"] }),
        ]);
      }
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");
    expect(screen.queryByTestId("correction-disapprove-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("correction-flag-UNCLEAR")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("correction-flags-toggle"));
    expect(screen.getByTestId("correction-flag-UNCLEAR")).toBeInTheDocument();
    // An open panel with no problem chosen holds the submission back, and a
    // note can go with the problem.
    expect(screen.getByTestId("correction-flag-choose")).toBeInTheDocument();
    expect(screen.getByTestId("correction-approve")).toBeDisabled();
    // Pointing at the greyed-out button says why.
    expect(screen.getByTestId("correction-approve-wrap").getAttribute("title")).toContain("flagAudioChoose");
    // The note is optional there, the main button sends it, and training
    // is not the corrector's choice.
    expect(screen.getByPlaceholderText("noteOptional")).toBeInTheDocument();
    expect(screen.queryByTestId("correction-send-note")).not.toBeInTheDocument();
    expect(screen.queryByTestId("correction-flag-EXCLUDE_FROM_TRAINING")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("correction-flags-toggle"));
    expect(screen.queryByTestId("correction-flag-choose")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("noteOptional")).not.toBeInTheDocument();

    // Only this person approved it: theirs to withdraw, not to disapprove.
    await userEvent.click(screen.getByText("machine 1"));
    await screen.findByDisplayValue("machine 1");
    expect(screen.queryByTestId("correction-disapprove-open")).not.toBeInTheDocument();

    // Somebody else approved it and it needs a second approval: this
    // person is the second pass and can say no.
    await userEvent.click(screen.getByText("machine 2"));
    await screen.findByDisplayValue("machine 2");
    expect(screen.getByTestId("correction-disapprove-open")).toBeInTheDocument();

    // A done segment changes only by an edit.
    await userEvent.click(screen.getByText("machine 3"));
    await screen.findByDisplayValue("machine 3");
    expect(screen.queryByTestId("correction-disapprove-open")).not.toBeInTheDocument();
  });

  // A segment that does not wait for this person offers "Continue", which
  // needs no listening and sends nothing; the list marks what does wait.
  it("offers Continue on a segment that is not waiting and goes to the next waiting one", async () => {
    const urls: string[] = [];
    fetchJsonMock.mockImplementation(async (input, init) => {
      const url = String(input);
      urls.push(`${init?.method ?? "GET"} ${url}`);
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
      if (url.includes("/spans?offset=0")) return page(0, 3, 3);
      if (/\/spans\/span-\d+$/.test(url)) return { spanId: "x", history: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderSurface(null);
    await screen.findByDisplayValue("machine 0");

    const primary = screen.getByTestId("correction-approve");
    await waitFor(() => expect(primary).toHaveAttribute("data-primary", "continue"));
    expect(primary).toBeEnabled();
    expect(screen.queryByText("listenBeforeApprove")).not.toBeInTheDocument();
    expect(screen.getByText("machine 2").closest("button")).toHaveAttribute("data-waiting", "true");
    expect(screen.getByText("machine 1").closest("button")).not.toHaveAttribute("data-waiting");

    await userEvent.click(primary);

    expect(await screen.findByDisplayValue("machine 2")).toBeInTheDocument();
    await waitFor(() => expect(lastPlayerProps().autoPlayOnSeek).toBe(true));
    expect(urls.some((url) => url.startsWith("POST"))).toBe(false);
    // On the last waiting segment the primary action is an approval again.
    expect(screen.getByTestId("correction-approve")).toHaveAttribute("data-primary", "approve");
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
    expect(await disapproveButton()).toBeEnabled();

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
    expect(screen.getByRole("button", { name: "saveAndApprove" })).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "saveAndApprove" }));

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
    expect(screen.getByRole("button", { name: "approve" })).toBeInTheDocument();
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
    expect(localStorage.getItem("besedy-correction-drafts:v1:user-1:ws-1")).toBeNull();
    expect(screen.getByRole("button", { name: "approve" })).toBeInTheDocument();
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
