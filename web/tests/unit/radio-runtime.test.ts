import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("asks for the AAC copy on WebKit when the recording has one", async () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    try {
      const runtime = createRadioRuntime();
      const stop = runtime.start();

      vi.mocked(fetchJson).mockResolvedValueOnce({
        hash: "track-1",
        eventId: 1,
        title: "Track",
        hasAacCopy: true,
        total: 2,
        historyReset: false,
      });
      await runtime.startRadio("catalog-1");
      expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-1/audio?format=aac");

      // A recording without a copy keeps the WebM rather than a 404.
      vi.mocked(fetchJson).mockResolvedValueOnce({
        hash: "track-2",
        eventId: 2,
        title: "Track 2",
        hasAacCopy: false,
        total: 2,
        historyReset: false,
      });
      await runtime.startRadio("catalog-1");
      expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-2/audio");
      stop();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("moves on to the next track when an AAC copy fails, without a WebM retry", async () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    try {
      const runtime = createRadioRuntime();
      const stop = runtime.start();
      vi.mocked(fetchJson).mockResolvedValueOnce({
        hash: "track-1",
        eventId: 1,
        title: "Track",
        hasAacCopy: true,
        total: 2,
        historyReset: false,
      });
      await runtime.startRadio("catalog-1");
      expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-1/audio?format=aac");

      vi.mocked(fetchJson).mockResolvedValueOnce({
        hash: "track-2",
        eventId: 2,
        title: "Track 2",
        hasAacCopy: false,
        total: 2,
        historyReset: false,
      });
      // Nothing loaded (a missing copy): no retry of the same track as WebM.
      audio.dispatchEvent(new Event("error"));

      await vi.waitFor(() =>
        expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-2/audio")
      );
      expect(runtime.getSnapshot().currentTrack?.hash).toBe("track-2");
      stop();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("keeps the WebM when the service worker does not key audio by format", async () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    // A worker from before #291 has no answer to the question.
    const controller = {
      postMessage: vi.fn((_message: unknown, ports: MessagePort[]) =>
        ports[0].postMessage({ type: "UNKNOWN" })
      ),
    };
    const serviceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller },
    });
    try {
      const runtime = createRadioRuntime();
      const stop = runtime.start();
      vi.mocked(fetchJson).mockResolvedValueOnce({
        hash: "track-1",
        eventId: 1,
        title: "Track",
        hasAacCopy: true,
        total: 2,
        historyReset: false,
      });
      await runtime.startRadio("catalog-1");

      expect(controller.postMessage).toHaveBeenCalledTimes(1);
      expect(audio.src).toBe("/api/catalogs/catalog-1/recordings/track-1/audio");
      stop();
    } finally {
      if (serviceWorker) Object.defineProperty(navigator, "serviceWorker", serviceWorker);
      else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      userAgent.mockRestore();
    }
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

  describe("sleep timer fade", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function playingRadio() {
      const runtime = createRadioRuntime();
      const stop = runtime.start();
      await runtime.startRadio("catalog-1");
      Object.assign(audio, { paused: false, ended: false });
      audio.pause.mockImplementation(() => {
        Object.assign(audio, { paused: true });
        audio.dispatchEvent(new Event("pause"));
      });
      audio.dispatchEvent(new Event("play"));
      return { runtime, stop };
    }

    it("fades the track out and pauses it", async () => {
      const { runtime, stop } = await playingRadio();
      runtime.setVolume(0.6);

      runtime.fadeOutAndPause();
      vi.advanceTimersByTime(2_500);
      expect(audio.volume).toBeCloseTo(0.3, 1);

      vi.advanceTimersByTime(2_500);
      expect(audio.pause).toHaveBeenCalledTimes(1);
      expect(audio.volume).toBe(0.6);
      expect(runtime.getSnapshot().isPlaying).toBe(false);
      expect(runtime.getSnapshot().isActive).toBe(true);

      stop();
    });

    it("stays on a track that ends during the fade, and resume moves on", async () => {
      const { runtime, stop } = await playingRadio();
      runtime.fadeOutAndPause();
      vi.advanceTimersByTime(1_000);

      Object.assign(audio, { paused: true, ended: true });
      audio.dispatchEvent(new Event("pause"));
      audio.dispatchEvent(new Event("ended"));
      await vi.runOnlyPendingTimersAsync();

      expect(fetchJson).toHaveBeenCalledTimes(1);
      expect(audio.volume).toBe(1);
      expect(runtime.getSnapshot().isPlaying).toBe(false);

      runtime.resume();
      await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
      expect(audio.play).toHaveBeenCalledTimes(2);

      stop();
    });

    it("plays on after a normal track end instead of fetching again", async () => {
      const { runtime, stop } = await playingRadio();
      // The next track's fetch fails and a retry is scheduled.
      vi.mocked(fetchJson).mockRejectedValueOnce(new Error("offline"));
      Object.assign(audio, { paused: true, ended: true });
      audio.dispatchEvent(new Event("ended"));
      await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));

      runtime.resume();
      expect(fetchJson).toHaveBeenCalledTimes(2);
      expect(audio.play).toHaveBeenCalledTimes(2);

      stop();
    });

    it("ends the fade when the listener changes the volume", async () => {
      const { runtime, stop } = await playingRadio();
      runtime.fadeOutAndPause();
      vi.advanceTimersByTime(2_000);

      runtime.setVolume(0.5);
      vi.advanceTimersByTime(5_000);

      expect(audio.pause).not.toHaveBeenCalled();
      expect(audio.volume).toBe(0.5);

      stop();
    });
  });
});
