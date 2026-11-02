import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioBufferDiagnostics } from "@/components/player/use-audio-buffer-diagnostics";

function audioBufferedTo(end: number) {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "buffered", {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => end },
  });
  return audio;
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
});
