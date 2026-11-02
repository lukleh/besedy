import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioBufferDiagnostics } from "@/components/player/use-audio-buffer-diagnostics";

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
  });

  it("holds the buffer reading while the page is hidden and reads it again when shown", () => {
    const audio = audioBufferedTo(100);
    // One ref for the hook's lifetime, as the player holds it.
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    expect(result.current.bufferInfo.bufferAhead).toBe(100);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    audio.currentTime = 30;
    act(() => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current.bufferInfo.bufferAhead).toBe(100);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.bufferInfo.bufferAhead).toBe(70);
  });

  it("keeps each chunk loaded while hidden instead of one merged chunk", () => {
    const audio = audioBufferedTo(10);
    const audioRef = { current: audio };
    const { result } = renderHook(() =>
      useAudioBufferDiagnostics({ audioRef, debugEnabled: false, src: "a.mp3" }),
    );
    expect(result.current.chunkFetches.map((chunk) => chunk.dataSeconds)).toEqual([10]);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    for (const end of [20, 35]) {
      setBufferedEnd(audio, end);
      act(() => {
        audio.dispatchEvent(new Event("progress"));
      });
    }
    expect(result.current.chunkFetches).toHaveLength(1);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.chunkFetches.map((chunk) => chunk.dataSeconds)).toEqual([10, 10, 15]);
  });
});
