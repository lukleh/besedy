import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioPlaybackProvider,
  useAudioPlayback,
} from "@/contexts/audio-playback-context";
import {
  ReloadSafetyProvider,
  useReloadSafety,
} from "@/contexts/reload-safety-context";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <ReloadSafetyProvider>
        <AudioPlaybackProvider>{children}</AudioPlaybackProvider>
      </ReloadSafetyProvider>
    </StrictMode>
  );
}

describe("recording playback reload safety", () => {
  beforeEach(() => vi.stubGlobal("BroadcastChannel", undefined));
  afterEach(() => vi.unstubAllGlobals());

  it("blocks automatic updates only while the page player is playing", () => {
    const { result } = renderHook(
      () => ({ playback: useAudioPlayback(), safety: useReloadSafety() }),
      { wrapper: Wrapper },
    );
    const reportPlaying = result.current.playback.setRecordingPlaying;
    expect(result.current.safety.blocksAutomatic).toBe(false);

    act(() => reportPlaying(true));
    expect(result.current.playback.isRecordingPlaying).toBe(true);
    expect(result.current.safety.automaticBlockerKinds).toEqual(["audio"]);
    expect(result.current.safety.blocksAutomatic).toBe(true);
    expect(result.current.safety.blocksManual).toBe(false);
    expect(result.current.playback.setRecordingPlaying).toBe(reportPlaying);

    act(() => reportPlaying(false));
    expect(result.current.playback.isRecordingPlaying).toBe(false);
    expect(result.current.safety.blocksAutomatic).toBe(false);
  });
});
