import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioBufferDiagnostics, useBufferDiagnostics } from "@/components/player/use-audio-buffer-diagnostics";

function audioBufferedTo(end: number) {
  const audio = document.createElement("audio");
  setBufferedEnd(audio, end);
  return audio;
}

function setBufferedEnd(audio: HTMLAudioElement, end: number) {
  Object.defineProperty(audio, "buffered", {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => end },
  });
}

describe("useAudioBufferDiagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("holds the buffer reading back while the page is hidden and tells the indicator when shown", () => {
    const audio = audioBufferedTo(100);
    // One ref for the hook's lifetime, as the player holds it.
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    expect(result.current.bufferInfo.get().bufferAhead).toBe(100);
    const listener = vi.fn();
    result.current.bufferInfo.subscribe(listener);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    audio.currentTime = 30;
    act(() => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(listener).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(listener).toHaveBeenCalled();
    expect(result.current.bufferInfo.get().bufferAhead).toBe(70);
  });

  it("restarts the peak when the exact buffer grows by more than a second", () => {
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    expect(result.current.bufferInfo.get().peakBuffer).toBe(10);

    audio.currentTime = 4.5;
    act(() => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    // 5.5 s left, then a refill of 1.4 s: rounded, 6 to 7 looks like one.
    setBufferedEnd(audio, 11.4);
    act(() => {
      audio.dispatchEvent(new Event("progress"));
    });
    expect(result.current.bufferInfo.get()).toMatchObject({ bufferAhead: 7, peakBuffer: 7 });
  });

  it("tells the indicator about the buffer reading only when its whole seconds change", () => {
    const audio = audioBufferedTo(100);
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    const listener = vi.fn();
    result.current.bufferInfo.subscribe(listener);

    for (const time of [30, 30.2, 30.4]) {
      audio.currentTime = time;
      act(() => {
        audio.dispatchEvent(new Event("timeupdate"));
      });
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.bufferInfo.get().bufferAhead).toBe(70);

    audio.currentTime = 31;
    act(() => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(result.current.bufferInfo.get().bufferAhead).toBe(69);
  });

  it("keeps each chunk loaded while hidden instead of one merged chunk", () => {
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    const source = result.current.diagnostics;
    const { result: panel } = renderHook(() => useBufferDiagnostics(source));
    expect(panel.current.chunkFetches.map((chunk) => chunk.dataSeconds)).toEqual([10]);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    for (const end of [20, 35]) {
      setBufferedEnd(audio, end);
      act(() => {
        audio.dispatchEvent(new Event("progress"));
      });
    }
    expect(panel.current.chunkFetches).toHaveLength(1);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(panel.current.chunkFetches.map((chunk) => chunk.dataSeconds)).toEqual([10, 10, 15]);
  });

  it("keeps a bounded history while closed and hidden without rendering its owner", () => {
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" });
    });
    const before = renders;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    for (let end = 11; end <= 35; end++) {
      setBufferedEnd(audio, end);
      act(() => audio.dispatchEvent(new Event("progress")));
    }
    expect(renders).toBe(before);
    // Opening the panel can read the last twenty original chunks immediately.
    const chunks = result.current.diagnostics.get().chunkFetches;
    expect(chunks).toHaveLength(20);
    expect(chunks[0]).toMatchObject({ id: 6, dataSeconds: 1, bufferEnd: 16 });
    expect(chunks.at(-1)).toMatchObject({ id: 25, dataSeconds: 1, bufferEnd: 35 });
  });

  it("polls only while debug is open and visible, and refreshes on return", () => {
    vi.useFakeTimers();
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { result, rerender, unmount } = renderHook(
      ({ debugEnabled }) => useAudioBufferDiagnostics({ audioRef, debugEnabled, src: "a.mp3" }),
      { initialProps: { debugEnabled: false } },
    );
    expect(vi.getTimerCount()).toBe(0);
    rerender({ debugEnabled: true });
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current.diagnostics.get().debugInfo.totalBuffered).toBe(10);

    setBufferedEnd(audio, 20);
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.diagnostics.get().debugInfo.totalBuffered).toBe(20);

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    setBufferedEnd(audio, 30);
    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.updateDebugInfo();
    });
    expect(result.current.diagnostics.get().debugInfo.totalBuffered).toBe(20);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current.diagnostics.get().debugInfo.totalBuffered).toBe(30);
    rerender({ debugEnabled: false });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("clears diagnostic readings and history when reset", () => {
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: true, src: "a.mp3" }),
    );
    expect(result.current.diagnostics.get().chunkFetches).toHaveLength(1);
    act(() => result.current.reset());
    expect(result.current.diagnostics.get()).toMatchObject({
      chunkFetches: [],
      debugInfo: { totalBuffered: 0, bufferedRanges: [] },
    });
    expect(result.current.bufferInfo.get()).toEqual({ bufferAhead: 0, peakBuffer: 0, networkState: 0 });
  });
});
