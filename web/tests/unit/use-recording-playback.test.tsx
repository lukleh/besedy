import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingPlayback } from "@/app/catalog/[catalogId]/recording/[hash]/use-recording-playback";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  radio: {
    currentTrack: null as { hash: string } | null,
    handOffPlayback: vi.fn(() => ({ time: 0, wasPlaying: false })),
    isActive: false,
    stopRadio: vi.fn(),
  },
  setRecordingPlaying: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/contexts/radio-mode-context", () => ({
  useRadioMode: () => mocks.radio,
}));

vi.mock("@/contexts/audio-playback-context", () => ({
  useAudioPlayback: () => ({
    isAudioPlaying: false,
    setRecordingPlaying: mocks.setRecordingPlaying,
  }),
}));

const HASH = "a".repeat(64);
const CATALOG_ID = "20260101_120000";
const STORAGE_KEY = `besedy-playback-${HASH}`;
const COMPLETION_KEY = `besedy-playback-completed-${HASH}`;

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

describe("useRecordingPlayback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00Z"));
    mocks.searchParams = new URLSearchParams();
    mocks.radio = {
      currentTrack: null,
      handOffPlayback: vi.fn(() => ({ time: 0, wasPlaying: false })),
      isActive: false,
      stopRadio: vi.fn(),
    };
    const storage = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage.set(key, value);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      storage.clear();
    });
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ progress: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    setVisibilityState("visible");
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("preserves an existing saved position when the page hides before playback initializes", () => {
    localStorage.setItem(STORAGE_KEY, "47");

    act(() => {
      renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("47");
  });

  it("saves on hide", () => {
    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));

    act(() => {
      result.current.setCurrentTime(91);
    });

    expect(result.current.currentTime).toBe(91);

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("91");
  });

  it("clears a stale saved position when the user seeks back to the start", () => {
    localStorage.setItem(STORAGE_KEY, "33");

    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));

    act(() => {
      vi.runAllTimers();
      result.current.handleSeek(0);
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("hands off radio playback when arriving from the radio on the same recording", async () => {
    mocks.searchParams = new URLSearchParams({ fromRadio: "true" });
    mocks.radio = {
      currentTrack: { hash: HASH },
      handOffPlayback: vi.fn(() => ({ time: 42, wasPlaying: true })),
      isActive: true,
      stopRadio: vi.fn(),
    };

    // StrictMode double-invokes the effect (setup -> cleanup -> setup), the
    // condition under which the old deferred-microtask handoff silently dropped
    // the seek. The handoff must still apply the position exactly once.
    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.radio.handOffPlayback).toHaveBeenCalledTimes(1);
    expect(mocks.radio.stopRadio).not.toHaveBeenCalled();
    // Playback continues at the handed-off position, auto-playing since the
    // radio was playing.
    expect(result.current.seekRequest?.time).toBe(42);
    expect(result.current.autoPlayOnSeek).toBe(true);
  });

  it("stops the radio (no handoff) when opened without the fromRadio flag", async () => {
    mocks.radio = {
      currentTrack: { hash: HASH },
      handOffPlayback: vi.fn(() => ({ time: 42, wasPlaying: true })),
      isActive: true,
      stopRadio: vi.fn(),
    };

    renderHook(() => useRecordingPlayback(CATALOG_ID, HASH), { wrapper: StrictMode });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.radio.stopRadio).toHaveBeenCalledTimes(1);
    expect(mocks.radio.handOffPlayback).not.toHaveBeenCalled();
  });

  it("restores a bounded seek from the URL", () => {
    mocks.searchParams = new URLSearchParams({ seek: "12.5", end: "18.75" });

    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));

    expect(result.current.seekRequest).toEqual({
      time: 12.5,
      end: 18.75,
      key: expect.any(Number),
    });
  });

  it("ignores an end that does not follow the URL seek", () => {
    mocks.searchParams = new URLSearchParams({ seek: "12.5", end: "12" });

    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));

    expect(result.current.seekRequest).toEqual({
      time: 12.5,
      key: expect.any(Number),
    });
  });

  it("restores a saved position synchronously under React Strict Mode", async () => {
    // Twin of the handoff seek: the same StrictMode setup -> cleanup -> setup
    // would drop a deferred-microtask restore, so it must be synchronous.
    localStorage.setItem(STORAGE_KEY, "47");

    const { result } = renderHook(() => useRecordingPlayback(CATALOG_ID, HASH), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.seekRequest?.time).toBe(47);
  });

  it("restores the furthest server position", async () => {
    localStorage.setItem(STORAGE_KEY, "20");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          progress: {
            positionSec: 75,
            durationSec: 100,
            completed: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );

    expect(result.current.seekRequest?.time).toBe(20);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.seekRequest?.time).toBe(75);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("75");
  });

  it("imports a browser position when it is further than server progress", async () => {
    localStorage.setItem(STORAGE_KEY, "75");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          progress: {
            positionSec: 20,
            durationSec: 100,
            completed: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.seekRequest?.time).toBe(75);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, request] = vi.mocked(fetch).mock.calls[1];
    expect(request).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(request?.body))).toEqual({
      positionSec: 75,
      durationSec: 100,
      completed: false,
    });
  });

  it("imports browser-only progress immediately", async () => {
    localStorage.setItem(STORAGE_KEY, "47");

    renderHook(() => useRecordingPlayback(CATALOG_ID, HASH));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [, request] = vi.mocked(fetch).mock.calls[1];
    expect(request).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(request?.body))).toEqual({
      positionSec: 47,
      durationSec: null,
      completed: false,
    });
  });

  it("keeps server completion authoritative and restarts at the beginning", async () => {
    localStorage.setItem(STORAGE_KEY, "75");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          progress: {
            positionSec: 100,
            durationSec: 100,
            completed: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.seekRequest?.time).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(COMPLETION_KEY)).toBe("true");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite further server progress when playback starts before restore", async () => {
    let resolveRestore: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRestore = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );

    act(() => {
      result.current.handlePlayingChange(true);
      result.current.setCurrentTime(1);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRestore?.(
        new Response(
          JSON.stringify({
            progress: {
              positionSec: 75,
              durationSec: 100,
              completed: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.seekRequest?.time).toBe(75);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throttles routine local saves while restore is pending", () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(() => {}));

    const { result } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );

    act(() => {
      result.current.handlePlayingChange(true);
      result.current.setCurrentTime(1);
    });
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setCurrentTime(2);
      vi.advanceTimersByTime(4_999);
      result.current.setCurrentTime(3);
    });
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
      result.current.setCurrentTime(4);
    });
    expect(localStorage.setItem).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.handlePlayingChange(false);
    });
    expect(localStorage.setItem).toHaveBeenCalledTimes(3);
  });

  it("does not run server restoration after a radio handoff", async () => {
    mocks.searchParams = new URLSearchParams({ fromRadio: "true" });
    const handOffPlayback = vi.fn(() => ({ time: 42, wasPlaying: false }));
    mocks.radio = {
      currentTrack: { hash: HASH },
      handOffPlayback,
      isActive: true,
      stopRadio: vi.fn(),
    };

    const { rerender } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );
    mocks.radio = {
      currentTrack: null,
      handOffPlayback,
      isActive: false,
      stopRadio: vi.fn(),
    };
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps actual-end completion durable without a later unfinished save", async () => {
    const { result, unmount } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.handleDurationChange(100);
      result.current.setCurrentTime(100);
      result.current.handleAudioEnded(100);
    });
    unmount();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(COMPLETION_KEY)).toBe("true");
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, completionRequest] = vi.mocked(fetch).mock.calls[1];
    expect(JSON.parse(String(completionRequest?.body))).toMatchObject({
      completed: true,
    });
  });

  it("deduplicates equivalent lifecycle saves", async () => {
    const { result, unmount } = renderHook(() =>
      useRecordingPlayback(CATALOG_ID, HASH)
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      result.current.setCurrentTime(91);
    });

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("beforeunload"));
    });
    unmount();

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
