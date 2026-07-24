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
const STORAGE_KEY = `besedy-playback-${HASH}`;

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
      renderHook(() => useRecordingPlayback(HASH));
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("47");
  });

  it("saves on hide", () => {
    const { result } = renderHook(() => useRecordingPlayback(HASH));

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

    const { result } = renderHook(() => useRecordingPlayback(HASH));

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
    const { result } = renderHook(() => useRecordingPlayback(HASH), {
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

    renderHook(() => useRecordingPlayback(HASH), { wrapper: StrictMode });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.radio.stopRadio).toHaveBeenCalledTimes(1);
    expect(mocks.radio.handOffPlayback).not.toHaveBeenCalled();
  });

  it("restores a saved position synchronously under React Strict Mode", async () => {
    // Twin of the handoff seek: the same StrictMode setup -> cleanup -> setup
    // would drop a deferred-microtask restore, so it must be synchronous.
    localStorage.setItem(STORAGE_KEY, "47");

    const { result } = renderHook(() => useRecordingPlayback(HASH), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.seekRequest?.time).toBe(47);
  });
});
