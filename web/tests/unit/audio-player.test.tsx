import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";

// Mock the service worker context
vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => ({
    isSupported: false,
    isRegistered: false,
    isReady: false,
    updateAvailable: false,
    error: null,
    wasDismissed: false,
    applyUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    postMessage: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
  }),
}));

const messages = {
  player: {
    play: "Play",
    pause: "Pause",
    skipBack: "Skip back",
    skipForward: "Skip forward",
    mute: "Mute",
    unmute: "Unmute",
    speed: "Playback speed",
    progress: "Playback progress",
    volume: "Volume",
    waveform: "Toggle waveform",
    keyboardHints: "Hints",
    reconnecting: "Reconnecting...",
  },
};

interface RenderPlayerOptions {
  src?: string;
  seekTo?: number;
  seekKey?: number;
  autoPlayOnSeek?: boolean;
  onTimeUpdate?: (time: number) => void;
}

function renderPlayer(options: RenderPlayerOptions = {}) {
  const { src = "https://example.com/audio.mp3", seekTo, seekKey, autoPlayOnSeek, onTimeUpdate } = options;
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AudioPlayer
        src={src}
        seekTo={seekTo}
        seekKey={seekKey}
        autoPlayOnSeek={autoPlayOnSeek}
        onTimeUpdate={onTimeUpdate}
      />
    </NextIntlClientProvider>
  );

  const audio = utils.container.querySelector("audio");
  if (!audio) {
    throw new Error("Audio element not found");
  }

  return { ...utils, audio };
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

function mockReadyState(audio: HTMLAudioElement, state: number) {
  Object.defineProperty(audio, "readyState", {
    value: state,
    configurable: true,
    writable: true,
  });
}

function setAudioError(audio: HTMLAudioElement, code: number) {
  Object.defineProperty(audio, "error", {
    value: { code },
    configurable: true,
  });
}

function mockPaused(audio: HTMLAudioElement, initial: boolean) {
  let paused = initial;
  Object.defineProperty(audio, "paused", {
    get: () => paused,
    configurable: true,
  });
  return (value: boolean) => {
    paused = value;
  };
}

afterEach(() => {
  localStorage.clear();
  setVisibilityState("visible");
});

beforeEach(() => {
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
});

describe("AudioPlayer play/pause controls", () => {
  it("calls play() when play button is clicked", async () => {
    const { audio, container } = renderPlayer();
    const playMock = vi.fn().mockResolvedValue(undefined);
    audio.play = playMock;

    const playButton = container.querySelector(
      '[data-testid="audio-play-button"]'
    ) as HTMLButtonElement;

    expect(playButton.getAttribute("aria-label")).toBe("Play");

    await act(async () => {
      playButton.click();
    });

    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("calls pause() when pause button is clicked", async () => {
    const { audio, container } = renderPlayer();
    const playMock = vi.fn().mockResolvedValue(undefined);
    const pauseMock = vi.fn();
    audio.play = playMock;
    audio.pause = pauseMock;

    const playButton = container.querySelector(
      '[data-testid="audio-play-button"]'
    ) as HTMLButtonElement;

    // Start playing
    await act(async () => {
      playButton.click();
    });

    // Simulate the audio element firing play event
    await act(async () => {
      audio.dispatchEvent(new Event("play"));
    });

    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    // Click to pause
    await act(async () => {
      playButton.click();
    });

    expect(pauseMock).toHaveBeenCalledTimes(1);
  });

  it("updates aria-label based on playing state", async () => {
    const { audio, container } = renderPlayer();
    audio.play = vi.fn().mockResolvedValue(undefined);
    audio.pause = vi.fn();

    const playButton = container.querySelector(
      '[data-testid="audio-play-button"]'
    ) as HTMLButtonElement;

    expect(playButton.getAttribute("aria-label")).toBe("Play");

    // Simulate play event
    await act(async () => {
      audio.dispatchEvent(new Event("play"));
    });

    expect(playButton.getAttribute("aria-label")).toBe("Pause");

    // Simulate pause event
    await act(async () => {
      audio.dispatchEvent(new Event("pause"));
    });

    expect(playButton.getAttribute("aria-label")).toBe("Play");
  });
});

describe("AudioPlayer skip controls", () => {
  it("skips backward 10 seconds when skip back button is clicked", async () => {
    const { audio, container } = renderPlayer();
    audio.currentTime = 30;

    const skipBackButton = container.querySelector(
      '[data-testid="audio-skip-backward"]'
    ) as HTMLButtonElement;

    await act(async () => {
      skipBackButton.click();
    });

    expect(audio.currentTime).toBe(20);
  });

  it("skips forward 10 seconds when skip forward button is clicked", async () => {
    const { audio, container } = renderPlayer();
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });

    // Fire loadedmetadata to update component state
    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    audio.currentTime = 30;

    const skipForwardButton = container.querySelector(
      '[data-testid="audio-skip-forward"]'
    ) as HTMLButtonElement;

    await act(async () => {
      skipForwardButton.click();
    });

    expect(audio.currentTime).toBe(40);
  });

  it("does not skip backward below 0", async () => {
    const { audio, container } = renderPlayer();
    audio.currentTime = 5;

    const skipBackButton = container.querySelector(
      '[data-testid="audio-skip-backward"]'
    ) as HTMLButtonElement;

    await act(async () => {
      skipBackButton.click();
    });

    expect(audio.currentTime).toBe(0);
  });

  it("does not skip forward beyond duration", async () => {
    const { audio, container } = renderPlayer();
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });

    // Fire loadedmetadata to update component state
    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    audio.currentTime = 95;

    const skipForwardButton = container.querySelector(
      '[data-testid="audio-skip-forward"]'
    ) as HTMLButtonElement;

    await act(async () => {
      skipForwardButton.click();
    });

    expect(audio.currentTime).toBe(100);
  });
});

describe("AudioPlayer retry logic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deduplicates errors while retry is pending and continues retry chain", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { audio, container } = renderPlayer();
    const loadMock = vi.fn();
    audio.load = loadMock;
    // Mock play() to return a resolved promise (prevents unhandled rejection)
    audio.play = vi.fn().mockResolvedValue(undefined);

    // Simulate user clicking play to enable retry logic
    // (retry only activates after user-initiated playback)
    const playButton = container.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    setAudioError(audio, 2);

    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(loadMock).toHaveBeenCalledTimes(1);

    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("restores position and resumes playback after reconnection", async () => {
    vi.useFakeTimers();

    const { audio, container } = renderPlayer();
    const playMock = vi.fn().mockResolvedValue(undefined);
    // Mock play() before any user interaction
    audio.play = playMock;

    // Simulate user clicking play to enable retry logic
    const playButton = container.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    // play() called once from button click
    expect(playMock).toHaveBeenCalledTimes(1);

    // Set up the state: was playing (paused=false) at position 42
    const setPaused = mockPaused(audio, false);
    setAudioError(audio, 2);
    audio.currentTime = 42;

    await act(async () => {
      audio.dispatchEvent(new Event("error"));
    });

    // After error, audio is reset
    audio.currentTime = 0;
    setPaused(true);

    await act(async () => {
      audio.dispatchEvent(new Event("canplay"));
    });

    expect(audio.currentTime).toBe(42);
    // play() called again on reconnection (total 2: initial + reconnect)
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry MEDIA_ERR_SRC_NOT_SUPPORTED when metadata never loaded", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { audio, container } = renderPlayer();
    audio.load = vi.fn();
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    const scheduledBefore = setTimeoutSpy.mock.calls.length;

    setAudioError(audio, 4);

    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // No retry timer should be scheduled because metadata never loaded.
    expect(setTimeoutSpy.mock.calls.length).toBe(scheduledBefore);
  });

  it("retries MEDIA_ERR_SRC_NOT_SUPPORTED once metadata has loaded", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { audio, container } = renderPlayer();
    audio.load = vi.fn();
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    // Metadata loads successfully before the error — proves format is supported.
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    const scheduledBefore = setTimeoutSpy.mock.calls.length;

    setAudioError(audio, 4);

    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // One retry should have been scheduled.
    expect(setTimeoutSpy.mock.calls.length).toBe(scheduledBefore + 1);
  });

  it("cancels the retry timer synchronously on recovery", async () => {
    // Regression: the retry timer used to live in the effect's local
    // closure. A canplay arriving before the timer elapsed dispatched
    // RECOVERED but didn't cancel the pending timer until the effect
    // re-ran on the next render — the stale callback could still fire and
    // call audio.load() on recovered audio.
    vi.useFakeTimers();

    const { audio, container } = renderPlayer();
    const loadMock = vi.fn();
    audio.load = loadMock;
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    setAudioError(audio, 2);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // Before the retry timer elapses, the browser recovers on its own.
    await act(async () => {
      audio.dispatchEvent(new Event("canplay"));
    });

    // Advance past when the retry would have fired. If the timer wasn't
    // cancelled, audio.load() would be called here.
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(loadMock).not.toHaveBeenCalled();
  });

  it("cancels the retry timer synchronously on src change", async () => {
    vi.useFakeTimers();

    const { audio, container, rerender } = renderPlayer();
    const loadMock = vi.fn();
    audio.load = loadMock;
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    setAudioError(audio, 2);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // Navigate to a different src while the retry timer is still pending.
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AudioPlayer src="https://example.com/other.mp3" />
      </NextIntlClientProvider>
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // A stale timer firing would call audio.load() on the new element.
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("does not fire a stale retry timer against a different src", async () => {
    // Regression: between React committing a new <audio src=...> value and
    // the src-change useEffect running to dispatch RESET, an already-queued
    // retry timer could fire and call audio.load() on the new element. This
    // simulates that pre-effect window by mutating audio.src directly so the
    // React effects don't have a chance to reset retry state.
    vi.useFakeTimers();

    const { audio, container } = renderPlayer();
    const loadMock = vi.fn();
    audio.load = loadMock;
    audio.play = vi.fn().mockResolvedValue(undefined);

    // Mock audio.src so we can change what it reports without going through
    // React. Starting value matches the prop we rendered with.
    let currentSrc = audio.src || "https://example.com/audio.mp3";
    Object.defineProperty(audio, "src", {
      configurable: true,
      get: () => currentSrc,
      set: (value: string) => {
        currentSrc = value;
      },
    });

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    setAudioError(audio, 2);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // Simulate React committing a new src before the src-change useEffect
    // gets to run. The retry timer is still pending at this point.
    currentSrc = "https://example.com/other.mp3";

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // The pending timer should have bailed because audio.src changed.
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("does not apply stale retry state on canplay from a different src", async () => {
    // Regression: if canplay fires for a newly-selected recording while the
    // RESET for the previous one hasn't dispatched yet, handleCanPlayAfterError
    // used to apply the old savedPosition/wasPlaying to the new element.
    vi.useFakeTimers();

    const { audio, container } = renderPlayer();
    audio.load = vi.fn();
    const playMock = vi.fn().mockResolvedValue(undefined);
    audio.play = playMock;

    let currentSrc = audio.src || "https://example.com/audio.mp3";
    Object.defineProperty(audio, "src", {
      configurable: true,
      get: () => currentSrc,
      set: (value: string) => {
        currentSrc = value;
      },
    });

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    const initialPlayCalls = playMock.mock.calls.length;

    // Error at position 42 with was-playing=true captures that state.
    const setPaused = mockPaused(audio, false);
    setAudioError(audio, 2);
    audio.currentTime = 42;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // Navigate (React commits new src; reset effect hasn't run yet).
    currentSrc = "https://example.com/other.mp3";
    audio.currentTime = 0;
    setPaused(true);

    await act(async () => {
      audio.dispatchEvent(new Event("canplay"));
    });

    // Without the src guard, currentTime would have been forced to 42 and
    // play() called on the new recording.
    expect(audio.currentTime).toBe(0);
    expect(playMock.mock.calls.length).toBe(initialPlayCalls);
  });

  it("advances retry chain when load() errors synchronously during the retry callback", async () => {
    // Regression: handleError reads retryStateRef, which used to be synced
    // via a useEffect that runs after commit. When TIMER_FIRED's dispatch
    // was followed by an immediately-failing audio.load(), the error
    // handler saw phase="scheduled" (stale) and deduped the failure as
    // ERROR_DETECTED instead of advancing via RELOAD_FAILED. The chain
    // stalled after attempt 1.
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { audio, container } = renderPlayer();

    // Mock audio.load() to SYNCHRONOUSLY fire an error event. This is the
    // "immediate offline / code-4 failure" case.
    audio.load = vi.fn(() => {
      setAudioError(audio, 4);
      audio.dispatchEvent(new Event("error"));
    });
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    setAudioError(audio, 2);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    const timersAfterFirstError = setTimeoutSpy.mock.calls.length;

    // Fire the retry timer — callback dispatches TIMER_FIRED then calls
    // audio.load(), which synchronously dispatches error code 4.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // If retryStateRef lagged, handleError would have seen phase=scheduled
    // and deduped, leaving no new timer. With synchronous sync, handleError
    // sees phase=reloading and dispatches RELOAD_FAILED → attempt 2 scheduled.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(timersAfterFirstError);
  });

  it("advances retry chain when the retry's reload fails before metadata loads", async () => {
    // Regression: an initial network error (code 2) would enter retry; the
    // retry's audio.load() failing with code 4 before any metadata loaded
    // used to fall through the retriability guard and strand the player in
    // "reloading" with isReconnecting stuck true. Now the reloading phase
    // always advances the chain regardless of error code.
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { audio, container } = renderPlayer();
    const loadMock = vi.fn();
    audio.load = loadMock;
    audio.play = vi.fn().mockResolvedValue(undefined);

    const playButton = container.querySelector(
      'button[aria-label="Play"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      playButton?.click();
    });

    // Initial network error triggers retry chain.
    setAudioError(audio, 2);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    const timersAfterFirstError = setTimeoutSpy.mock.calls.length;
    expect(timersAfterFirstError).toBeGreaterThan(0);

    // Advance through first retry delay → audio.load() called, phase = reloading.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(loadMock).toHaveBeenCalledTimes(1);

    // The retry's load() fails with code 4 before metadata ever loaded
    // (metadataLoadedRef still false). The retry chain must still advance.
    setAudioError(audio, 4);
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    // A new retry timer must be scheduled for attempt #2 — previously the
    // player got stuck with no further progress.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(timersAfterFirstError);
  });
});

describe("AudioPlayer external seek", () => {
  it("applies seek immediately when metadata is already loaded", async () => {
    const onTimeUpdate = vi.fn();
    const { audio, rerender } = renderPlayer({
      onTimeUpdate,
    });

    // Simulate metadata already loaded (readyState >= 1)
    mockReadyState(audio, 1);
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });

    // Dispatch loadedmetadata to sync component state
    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    // Now re-render with seekTo - since metadata is loaded, it should apply immediately
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AudioPlayer
          src="https://example.com/audio.mp3"
          seekTo={25}
          seekKey={1}
          onTimeUpdate={onTimeUpdate}
        />
      </NextIntlClientProvider>
    );

    // The seek should happen immediately because readyState >= 1
    expect(audio.currentTime).toBe(25);
    expect(onTimeUpdate).toHaveBeenCalledWith(25);
  });

  it("queues seek when metadata not loaded and applies on loadedmetadata", async () => {
    const onTimeUpdate = vi.fn();
    const { audio } = renderPlayer({
      seekTo: 30,
      seekKey: 1,
      onTimeUpdate,
    });

    // Default readyState is 0 (HAVE_NOTHING) - metadata not loaded
    // Verify seek was NOT applied immediately
    expect(audio.currentTime).toBe(0);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    // Now simulate metadata loading
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockReadyState(audio, 1);

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    // After metadata loads, the queued seek should be applied
    expect(audio.currentTime).toBe(30);
    expect(onTimeUpdate).toHaveBeenCalledWith(30);
  });

  it("auto-plays after queued seek when autoPlayOnSeek is true", async () => {
    const onTimeUpdate = vi.fn();
    const { audio } = renderPlayer({
      seekTo: 15,
      seekKey: 1,
      autoPlayOnSeek: true,
      onTimeUpdate,
    });

    const playMock = vi.fn().mockResolvedValue(undefined);
    audio.play = playMock;

    // Verify seek not applied yet (no metadata)
    expect(audio.currentTime).toBe(0);
    expect(playMock).not.toHaveBeenCalled();

    // Load metadata
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockReadyState(audio, 1);

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    // Seek should be applied and play() should be called
    expect(audio.currentTime).toBe(15);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("does not auto-play after queued seek when autoPlayOnSeek is false", async () => {
    const onTimeUpdate = vi.fn();
    const { audio } = renderPlayer({
      seekTo: 20,
      seekKey: 1,
      autoPlayOnSeek: false,
      onTimeUpdate,
    });

    const playMock = vi.fn().mockResolvedValue(undefined);
    audio.play = playMock;

    // Load metadata
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockReadyState(audio, 1);

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    // Seek should be applied but play() should NOT be called
    expect(audio.currentTime).toBe(20);
    expect(playMock).not.toHaveBeenCalled();
  });

  it("preserves queued seek when source switches for the same recording hash", async () => {
    const hash = "a".repeat(64);
    const catalogId = "20250101_120000";
    const srcA = `/api/catalogs/${catalogId}/recordings/${hash}/audio`;
    const srcB = `/api/catalogs/${catalogId}/recordings/${hash}/audio?source=listening&variant=clean`;

    const onTimeUpdate = vi.fn();
    const { audio, rerender } = renderPlayer({
      src: srcA,
      seekTo: 33,
      seekKey: 1,
      onTimeUpdate,
    });

    // Still no metadata, so seek is queued and not yet applied.
    expect(audio.currentTime).toBe(0);

    // Source switches before metadata arrives (e.g., async source preference load).
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AudioPlayer
          src={srcB}
          seekTo={33}
          seekKey={1}
          onTimeUpdate={onTimeUpdate}
        />
      </NextIntlClientProvider>
    );

    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockReadyState(audio, 1);

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(audio.currentTime).toBe(33);
    expect(onTimeUpdate).toHaveBeenCalledWith(33);
  });
});

describe("AudioPlayer lifecycle resume", () => {
  it("restores the saved position when a visible page resumes with the audio reset to zero", async () => {
    const hash = "a".repeat(64);
    const onTimeUpdate = vi.fn();
    const { audio } = renderPlayer({
      src: `/api/catalogs/20250101_120000/recordings/${hash}/audio`,
      onTimeUpdate,
    });

    await act(async () => {});

    localStorage.setItem(`besedy-playback-${hash}`, "47");
    mockReadyState(audio, 1);
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockPaused(audio, true);
    audio.currentTime = 0;

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    await act(async () => {
      setVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(audio.currentTime).toBe(47);
    expect(onTimeUpdate).toHaveBeenCalledWith(47);
  });

  it("does not re-seek on resume when the audio element already kept its exact position", async () => {
    const hash = "b".repeat(64);
    const onTimeUpdate = vi.fn();
    const { audio } = renderPlayer({
      src: `/api/catalogs/20250101_120000/recordings/${hash}/audio`,
      onTimeUpdate,
    });

    await act(async () => {});

    localStorage.setItem(`besedy-playback-${hash}`, "47");
    mockReadyState(audio, 1);
    Object.defineProperty(audio, "duration", { value: 100, configurable: true });
    mockPaused(audio, true);
    audio.currentTime = 47.6;

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    await act(async () => {
      setVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(audio.currentTime).toBe(47.6);
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });
});
