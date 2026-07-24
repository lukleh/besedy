import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRadioRuntime } from "@/lib/radio/runtime";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("@/lib/api/fetch-json", () => ({
  fetchJson: vi.fn(),
}));

class MockAudio extends EventTarget {
  preload = "";
  src = "";
  currentTime = 0;
  duration = 0;
  volume = 1;
  networkState = 0;
  readyState = 0;
  error: { code?: number; message?: string } | null = null;
  buffered = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };

  load = vi.fn();
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
}

describe("createRadioRuntime", () => {
  let audio: MockAudio;

  beforeEach(() => {
    vi.clearAllMocks();
    audio = new MockAudio();
    vi.stubGlobal(
      "Audio",
      vi.fn(function AudioMock() {
        return audio;
      })
    );
    vi.mocked(fetchJson).mockResolvedValue({
      hash: "track-1",
      eventId: 7,
      title: "Track 1",
      duration: "00:01:00",
      dateYear: 2024,
      dateMonth: 3,
      dateDay: 15,
      locationName: "Location X",
      total: 1,
      historyReset: false,
    });
    window.localStorage.clear();
  });

  it("starts radio playback and updates snapshot from audio events", async () => {
    const runtime = createRadioRuntime();
    const snapshots = [runtime.getSnapshot()];
    runtime.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    const stop = runtime.start();
    await runtime.startRadio("catalog-1");

    expect(fetchJson).toHaveBeenCalledWith("/api/catalogs/catalog-1/random-event?");
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-1/audio");
    expect(runtime.getSnapshot().currentTrack?.hash).toBe("track-1");
    // Event metadata propagates from the response into the current track.
    expect(runtime.getSnapshot().currentTrack?.eventId).toBe(7);
    expect(runtime.getSnapshot().currentTrack?.locationName).toBe("Location X");
    expect(runtime.getSnapshot().isActive).toBe(true);

    audio.duration = 60;
    audio.dispatchEvent(new Event("durationchange"));
    audio.dispatchEvent(new Event("canplay"));
    audio.dispatchEvent(new Event("play"));

    expect(runtime.getSnapshot().duration).toBe(60);
    expect(runtime.getSnapshot().isLoading).toBe(false);
    expect(runtime.getSnapshot().isPlaying).toBe(true);
    expect(snapshots.at(-1)?.currentTrack?.title).toBe("Track 1");

    stop();
  });

  it("hands off playback without clearing listening history", async () => {
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => {
      if (key === "besedy-radio-history-catalog-1") {
        return JSON.stringify(["old-track"]);
      }
      return null;
    });

    const runtime = createRadioRuntime();
    const stop = runtime.start();
    await runtime.startRadio("catalog-1");

    audio.currentTime = 42;
    audio.dispatchEvent(new Event("play"));

    const handoff = runtime.handOffPlayback();

    expect(handoff).toEqual({ time: 42, wasPlaying: true });
    expect(runtime.getSnapshot().isActive).toBe(false);
    expect(runtime.getSnapshot().currentTrack).toBeNull();
    expect(audio.pause).toHaveBeenCalled();
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      "besedy-radio-history-catalog-1",
      JSON.stringify(["old-track", "track-1"])
    );

    stop();
  });

  it("updates volume and mute state through the runtime controls", () => {
    const runtime = createRadioRuntime();
    const stop = runtime.start();

    runtime.setVolume(0.3);
    expect(audio.volume).toBe(0.3);
    expect(runtime.getSnapshot().volume).toBe(0.3);
    expect(runtime.getSnapshot().isMuted).toBe(false);

    runtime.toggleMute();
    expect(audio.volume).toBe(0);
    expect(runtime.getSnapshot().isMuted).toBe(true);

    runtime.toggleMute();
    expect(audio.volume).toBe(0.3);
    expect(runtime.getSnapshot().isMuted).toBe(false);

    stop();
  });

  it("records the stop reason on the radio snapshot", async () => {
    // Empty pool: the route returned no track to play.
    vi.mocked(fetchJson).mockResolvedValue({
      hash: null,
      total: 0,
      historyReset: false,
    });

    const runtime = createRadioRuntime();
    const stop = runtime.start();
    await runtime.startRadio("catalog-1");

    expect(runtime.getSnapshot().isActive).toBe(false);
    expect(runtime.getSnapshot().stopReason).toBe("empty-pool");

    // A subsequent user stop is recorded distinctly (this drives the
    // empty-pool toast's one-time transition guard in the banner).
    runtime.stopRadio();
    expect(runtime.getSnapshot().stopReason).toBe("user-stop");

    stop();
  });
});
