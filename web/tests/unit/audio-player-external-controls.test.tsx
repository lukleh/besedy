import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";
import type { AudioPlayerControls, AudioPlayerHandle, AudioPlayerProps } from "@/components/player/audio-player-types";
import messages from "../../messages/en.json";

vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => ({
    isSupported: false,
    postMessage: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
  }),
}));

function setup(props: Partial<AudioPlayerProps> = {}) {
  const ref = createRef<AudioPlayerHandle>();
  const tree = (nextProps: Partial<AudioPlayerProps>) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <AudioPlayer src="https://example.com/audio.mp3" {...nextProps} ref={ref} />
    </NextIntlClientProvider>
  );
  const view = render(tree(props));
  const audio = view.container.querySelector("audio")!;
  let paused = true;
  let rejectPlay = false;
  Object.defineProperty(audio, "paused", { configurable: true, get: () => paused });
  const setReadyState = (value: number) => {
    Object.defineProperty(audio, "readyState", { configurable: true, value });
  };
  const setError = (value: { code: number } | null) => {
    Object.defineProperty(audio, "error", { configurable: true, value });
  };
  audio.play = vi.fn(() => {
    if (rejectPlay) return Promise.reject(new DOMException("Not ready", "NotSupportedError"));
    paused = false;
    audio.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  audio.pause = vi.fn(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  audio.load = vi.fn(() => {
    setError(null);
    setReadyState(0);
    audio.currentTime = 0;
    paused = true;
  });
  const metadata = () => {
    setReadyState(4);
    Object.defineProperty(audio, "duration", { configurable: true, value: 120 });
    audio.dispatchEvent(new Event("loadedmetadata"));
  };

  return {
    ...view,
    audio,
    handle: () => ref.current!,
    metadata,
    fail: (code = 2) => {
      paused = true;
      audio.dispatchEvent(new Event("pause"));
      setError({ code });
      audio.dispatchEvent(new Event("error"));
    },
    rejectPlay: (value: boolean) => { rejectPlay = value; },
    rerenderPlayer: (nextProps: Partial<AudioPlayerProps>) => view.rerender(tree({ ...props, ...nextProps })),
  };
}

function setupCustom(props: Partial<AudioPlayerProps> = {}) {
  let controls: AudioPlayerControls;
  const view = setup({
    ...props,
    renderControls: (value) => {
      controls = value;
      return <div data-testid="custom-controls">Segment controls</div>;
    },
  });
  return { ...view, controls: () => controls };
}

function mockMediaSession() {
  const handlers = new Map<MediaSessionAction, () => void>();
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      playbackState: "none",
      setActionHandler: (action: MediaSessionAction, handler: (() => void) | null) => {
        if (handler) handlers.set(action, handler);
        else handlers.delete(action);
      },
    },
  });
  return {
    handlers,
    restore: () => {
      if (original) Object.defineProperty(navigator, "mediaSession", original);
      else Reflect.deleteProperty(navigator, "mediaSession");
    },
  };
}

const originalLoad = HTMLMediaElement.prototype.load;

beforeAll(() => {
  HTMLMediaElement.prototype.load = () => {};
});

afterAll(() => {
  HTMLMediaElement.prototype.load = originalLoad;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AudioPlayer custom segment controls", () => {
  it("replaces the full controls and keeps the same audio element when the segment changes", () => {
    const { audio, container, queryByTestId, rerenderPlayer } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    expect(queryByTestId("custom-controls")).toBeInTheDocument();
    expect(queryByTestId("audio-play-button")).not.toBeInTheDocument();
    expect(queryByTestId("sleep-timer-button")).not.toBeInTheDocument();
    expect(container.querySelectorAll("audio")).toHaveLength(1);

    rerenderPlayer({ seekTo: 30, seekKey: 1, playbackRange: { start: 30, end: 40 } });
    expect(container.querySelector("audio")).toBe(audio);
    expect(queryByTestId("custom-controls")).toBeInTheDocument();
    expect(queryByTestId("audio-play-button")).not.toBeInTheDocument();
  });

  it.each([false, true])("clamps custom seeks without changing playing=%s and rearms the segment end", async (playing) => {
    const onSeek = vi.fn();
    const onTimeUpdate = vi.fn();
    const { audio, handle, metadata, controls } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
      onSeek,
      onTimeUpdate,
    });
    act(metadata);
    if (playing) await act(async () => handle().play(15));
    const playCalls = vi.mocked(audio.play).mock.calls.length;
    onTimeUpdate.mockClear();
    act(() => controls().seek(1));
    expect(audio.currentTime).toBe(10);
    expect(audio.paused).toBe(!playing);
    expect(audio.play).toHaveBeenCalledTimes(playCalls);
    expect(onSeek).toHaveBeenLastCalledWith(10);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(10);
    expect(onSeek.mock.invocationCallOrder.at(-1)).toBeLessThan(onTimeUpdate.mock.invocationCallOrder.at(-1)!);

    act(() => controls().seek(14));
    if (!playing) await act(async () => handle().play());
    audio.currentTime = 16;
    act(() => fireEvent.timeUpdate(audio));
    expect(audio.paused).toBe(false);
    audio.currentTime = 20.2;
    act(() => fireEvent.timeUpdate(audio));
    expect(audio.currentTime).toBe(20);
    expect(audio.paused).toBe(true);

    act(() => controls().seek(100));
    expect(audio.currentTime).toBe(20);
    expect(onSeek).toHaveBeenLastCalledWith(20);
    expect(audio.paused).toBe(true);
  });

  it.each([undefined, 10])("queues a paused seek before metadata with initial position %s", (seekTo) => {
    const { audio, handle, controls, metadata } = setupCustom({
      seekTo,
      playbackRange: { start: 10, end: 20 },
    });
    act(() => controls().seek(200));
    expect(handle().getCurrentTime()).toBe(20);
    expect(handle().isPlayRequested()).toBe(false);
    act(metadata);
    expect(audio.currentTime).toBe(20);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it.each(["pageshow", "visibilitychange"])("restores the paused segment position after %s instead of a recording-wide position", (event) => {
    const { audio, controls, metadata } = setupCustom({
      recordingHash: "a".repeat(64),
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    act(metadata);
    act(() => controls().seek(14.5));
    // A suspended tab can return with its media element reset to zero.
    audio.currentTime = 0;
    act(() => {
      if (event === "pageshow") window.dispatchEvent(new Event(event));
      else {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event(event));
      }
    });
    expect(audio.currentTime).toBe(14.5);
    expect(audio.paused).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("keeps a changed seek position and paused intent through reconnect", async () => {
    vi.useFakeTimers();
    const { audio, handle, controls, metadata, fail } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    act(metadata);
    await act(async () => handle().play());
    audio.currentTime = 12;
    act(fail);
    expect(controls().isReconnecting).toBe(true);
    act(() => handle().pause());
    act(() => controls().seek(18.5));
    act(() => vi.advanceTimersByTime(1_000));
    act(metadata);
    act(() => audio.dispatchEvent(new Event("canplay")));
    expect(handle().getCurrentTime()).toBe(18.5);
    expect(audio.paused).toBe(true);
    expect(handle().isPlayRequested()).toBe(false);
    expect(controls().isReconnecting).toBe(false);
  });

  it("uses Space and arrow keys within the segment and restarts a finished segment", async () => {
    const { audio, controls, metadata } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    act(metadata);
    act(() => fireEvent.keyDown(document.body, { code: "ArrowLeft" }));
    expect(audio.currentTime).toBe(10);
    act(() => controls().seek(19));
    act(() => fireEvent.keyDown(document.body, { code: "ArrowRight" }));
    expect(audio.currentTime).toBe(20);
    expect(audio.paused).toBe(true);

    await act(async () => fireEvent.keyDown(document.body, { code: "Space" }));
    expect(audio.currentTime).toBe(10);
    expect(audio.paused).toBe(false);
    audio.currentTime = 20.1;
    act(() => fireEvent.timeUpdate(audio));
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(20);
  });

  it("keeps lock-screen seek and play actions within the segment", async () => {
    const { handlers, restore } = mockMediaSession();
    try {
      const { audio, metadata } = setupCustom({ seekTo: 10, playbackRange: { start: 10, end: 20 } });
      act(metadata);
      act(() => handlers.get("seekbackward")!());
      expect(audio.currentTime).toBe(10);
      act(() => handlers.get("seekforward")!());
      expect(audio.currentTime).toBe(20);
      await act(async () => handlers.get("play")!());
      expect(audio.currentTime).toBe(10);
      expect(audio.paused).toBe(false);
      audio.currentTime = 20.2;
      act(() => fireEvent.timeUpdate(audio));
      expect(audio.currentTime).toBe(20);
      expect(audio.paused).toBe(true);
    } finally {
      restore();
    }
  });

  it("ignores keyboard, media-session and custom playback seeks while no segment range is available", async () => {
    const { handlers, restore } = mockMediaSession();
    try {
      const onSeek = vi.fn();
      const { audio, metadata, controls, handle } = setupCustom({
        playbackRange: { start: 0, end: 0 },
        onSeek,
      });
      act(metadata);
      audio.currentTime = 35;
      await act(async () => {
        fireEvent.keyDown(document.body, { code: "Space" });
        fireEvent.keyDown(document.body, { code: "ArrowLeft" });
        fireEvent.keyDown(document.body, { code: "ArrowRight" });
        handlers.get("play")!();
        handlers.get("seekbackward")!();
        handlers.get("seekforward")!();
        controls().seek(12);
        handle().play(20);
      });
      expect(audio.play).not.toHaveBeenCalled();
      expect(audio.currentTime).toBe(35);
      expect(audio.paused).toBe(true);
      expect(handle().isPlayRequested()).toBe(false);
      expect(onSeek).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("exposes volume, mute and buffering state to the replacement controls", () => {
    const { audio, controls } = setupCustom();
    act(() => controls().setVolume(0.35));
    expect(audio.volume).toBe(0.35);
    expect(controls().volume).toBe(0.35);
    expect(controls().isMuted).toBe(false);
    act(() => controls().toggleMute());
    expect(audio.volume).toBe(0);
    expect(controls().isMuted).toBe(true);
    act(() => controls().toggleMute());
    expect(audio.volume).toBe(0.35);
    expect(controls().isMuted).toBe(false);
    act(() => fireEvent.waiting(audio));
    expect(controls().isBuffering).toBe(true);
    act(() => fireEvent.canPlay(audio));
    expect(controls().isBuffering).toBe(false);
  });

  it("offers an explicit paused retry after a terminal media failure", async () => {
    const { audio, handle, metadata, fail, controls } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    act(metadata);
    await act(async () => handle().play());
    audio.currentTime = 14.5;
    act(() => fail(3));
    expect(controls().hasError).toBe(true);
    expect(controls().isReconnecting).toBe(false);

    act(() => controls().retry());
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(handle().getCurrentTime()).toBe(14.5);
    expect(handle().isPlayRequested()).toBe(false);
    expect(controls().hasError).toBe(false);
    act(metadata);
    act(() => fireEvent.canPlay(audio));
    expect(audio.currentTime).toBe(14.5);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("exposes exhausted retries as an error and allows a fresh paused retry", async () => {
    vi.useFakeTimers();
    const { audio, handle, metadata, fail, controls } = setupCustom({
      seekTo: 10,
      playbackRange: { start: 10, end: 20 },
    });
    act(metadata);
    await act(async () => handle().play());
    audio.currentTime = 14.5;
    act(() => fireEvent.timeUpdate(audio));
    act(fail);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      act(() => vi.advanceTimersByTime(Math.min(1_000 * 2 ** attempt, 30_000)));
      act(() => fail(4));
    }
    expect(controls().isReconnecting).toBe(false);
    expect(controls().hasError).toBe(true);
    act(() => controls().retry());
    expect(controls().hasError).toBe(false);
    expect(handle().getCurrentTime()).toBe(14.5);
    expect(handle().isPlayRequested()).toBe(false);
    act(metadata);
    expect(audio.currentTime).toBe(14.5);
    expect(audio.paused).toBe(true);
  });
});

describe("AudioPlayer external controls", () => {
  it("pauses and resumes at the exact position while preserving the requested excerpt end", async () => {
    const { audio, handle, metadata } = setup({ seekTo: 10.125 });
    act(metadata);
    await act(async () => handle().play(20.875));
    audio.currentTime = 14.375;

    act(() => handle().pause());
    expect(handle().getCurrentTime()).toBe(14.375);
    expect(handle().isPlayRequested()).toBe(false);
    await act(async () => handle().play());
    expect(audio.currentTime).toBe(14.375);
    expect(handle().isPlayRequested()).toBe(true);

    audio.currentTime = 20.9;
    act(() => fireEvent.timeUpdate(audio));
    expect(audio.currentTime).toBe(20.875);
    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(handle().isPlayRequested()).toBe(false);
  });

  it("cancels autoplay requested before metadata without discarding the pending seek", () => {
    const { audio, handle, metadata } = setup({ seekTo: 12.125, autoPlayOnSeek: true });
    expect(handle().isPlayRequested()).toBe(true);
    act(() => handle().pause());
    expect(handle().isPlayRequested()).toBe(false);

    act(metadata);
    expect(audio.currentTime).toBe(12.125);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("honors a rapid queued play then pause before metadata arrives", () => {
    const { audio, handle, metadata } = setup({ seekTo: 7.25 });
    act(() => {
      handle().play(15.5);
      expect(handle().isPlayRequested()).toBe(true);
      handle().pause();
      expect(handle().isPlayRequested()).toBe(false);
    });

    act(metadata);
    expect(audio.currentTime).toBe(7.25);
    // The play inside the click is the only one: the pause cancelled the queue.
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(true);
    expect(handle().isPlayRequested()).toBe(false);
  });

  it("starts playback inside the click even while a seek waits for metadata", async () => {
    const onPlayRequestChange = vi.fn();
    const { audio, handle, metadata, getByTestId } = setup({ seekTo: 31.5, onPlayRequestChange });
    await act(async () => fireEvent.click(getByTestId("audio-play-button")));
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(onPlayRequestChange).toHaveBeenLastCalledWith(true);
    // Until metadata arrives the element reports 0; the handle reports the target.
    expect(handle().getCurrentTime()).toBe(31.5);

    act(metadata);
    expect(audio.currentTime).toBe(31.5);
    expect(audio.paused).toBe(false);
  });

  it("reports the reconnect restore position and a held play request while offline", async () => {
    vi.useFakeTimers();
    const onPlayRequestChange = vi.fn();
    const { audio, handle, metadata, fail } = setup({ onPlayRequestChange });
    act(metadata);
    await act(async () => handle().play());
    audio.currentTime = 17.75;
    act(fail);
    // Paused by the error, but the reconnect will resume it.
    expect(onPlayRequestChange).toHaveBeenLastCalledWith(true);
    act(() => vi.advanceTimersByTime(1_000));
    expect(audio.currentTime).toBe(0);
    expect(handle().getCurrentTime()).toBe(17.75);

    const playsBefore = vi.mocked(audio.play).mock.calls.length;
    act(() => handle().pause());
    expect(onPlayRequestChange).toHaveBeenLastCalledWith(false);
    await act(async () => handle().play(25));
    // Queued for the reconnect rather than played on the failed element.
    expect(audio.play).toHaveBeenCalledTimes(playsBefore);
    expect(onPlayRequestChange).toHaveBeenLastCalledWith(true);
  });

  it.each(["scheduled", "reloading"])(
    "does not automatically resume after an explicit pause during %s recovery",
    async (phase) => {
      vi.useFakeTimers();
      const { audio, handle, metadata, fail } = setup();
      act(metadata);
      await act(async () => handle().play());
      audio.currentTime = 23.375;
      act(fail);
      if (phase === "reloading") act(() => vi.advanceTimersByTime(1_000));

      act(() => handle().pause());
      expect(handle().isPlayRequested()).toBe(false);
      if (phase === "scheduled") act(() => vi.advanceTimersByTime(1_000));
      act(metadata);
      act(() => audio.dispatchEvent(new Event("canplay")));

      expect(audio.currentTime).toBe(23.375);
      expect(audio.play).toHaveBeenCalledTimes(1);
      expect(handle().isPlayRequested()).toBe(false);
    }
  );

  it("re-enables automatic resume when play is requested again during recovery", async () => {
    vi.useFakeTimers();
    const { audio, handle, metadata, fail, rejectPlay } = setup();
    act(metadata);
    await act(async () => handle().play());
    audio.currentTime = 19.625;
    act(fail);
    act(() => vi.advanceTimersByTime(1_000));
    act(() => handle().pause());
    rejectPlay(true);
    await act(async () => handle().play());
    expect(handle().isPlayRequested()).toBe(true);
    expect(audio.paused).toBe(true);
    const attemptsBeforeRecovery = vi.mocked(audio.play).mock.calls.length;

    rejectPlay(false);
    act(metadata);
    await act(async () => audio.dispatchEvent(new Event("canplay")));

    expect(audio.currentTime).toBe(19.625);
    expect(audio.play).toHaveBeenCalledTimes(attemptsBeforeRecovery + 1);
    expect(audio.paused).toBe(false);
    expect(handle().isPlayRequested()).toBe(true);
  });

  it("allows another play attempt after an idle play is blocked by browser policy", async () => {
    const { audio, handle, metadata } = setup();
    act(metadata);
    vi.mocked(audio.play).mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"));

    await act(async () => handle().play());
    expect(audio.paused).toBe(true);
    expect(handle().isPlayRequested()).toBe(false);

    await act(async () => handle().play());
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.paused).toBe(false);
    expect(handle().isPlayRequested()).toBe(true);
  });

  it("reflects the main player's actual play and pause controls through the same handle", async () => {
    const { audio, handle, metadata, getByTestId } = setup();
    act(metadata);
    const button = getByTestId("audio-play-button");
    expect(handle().isPlayRequested()).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(handle().isPlayRequested()).toBe(true);
    expect(button).toHaveAttribute("aria-label", "Pause");

    audio.currentTime = 28.337;
    expect(handle().getCurrentTime()).toBe(28.337);
    act(() => fireEvent.click(button));
    expect(handle().isPlayRequested()).toBe(false);
    expect(button).toHaveAttribute("aria-label", "Play");
    expect(audio.pause).toHaveBeenCalledTimes(1);
  });

  it("leaves Space on an opted-in button to its native action and keeps body Space playback shortcuts", async () => {
    const { audio, handle, metadata, container } = setup();
    act(metadata);
    const nativeArea = document.createElement("div");
    nativeArea.setAttribute("data-native-space", "");
    const externalButton = document.createElement("button");
    externalButton.type = "button";
    externalButton.textContent = "Play segment";
    nativeArea.append(externalButton);
    container.append(nativeArea);
    externalButton.focus();
    expect(document.activeElement).toBe(externalButton);
    const buttonSpace = new KeyboardEvent("keydown", {
      key: " ", code: "Space", bubbles: true, cancelable: true,
    });

    act(() => externalButton.dispatchEvent(buttonSpace));
    expect(buttonSpace.defaultPrevented).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    expect(handle().isPlayRequested()).toBe(false);

    externalButton.blur();
    const bodySpace = new KeyboardEvent("keydown", {
      key: " ", code: "Space", bubbles: true, cancelable: true,
    });
    await act(async () => { document.body.dispatchEvent(bodySpace); });
    expect(bodySpace.defaultPrevented).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(handle().isPlayRequested()).toBe(true);
  });

  it.each(["before", "after"])(
    "resumes from the reconnect position after a pause during reload, %s metadata returns",
    async (stage) => {
      vi.useFakeTimers();
      const { audio, handle, metadata, fail } = setup({ seekTo: 10 });
      act(metadata);
      await act(async () => handle().play(30));
      audio.currentTime = 23.375;
      act(fail);
      act(() => vi.advanceTimersByTime(1_000));
      act(() => handle().pause());
      // The reload has emptied the element; metadata may already be back
      // while the data needed to recover is not.
      if (stage === "after") act(metadata);
      expect(audio.currentTime).toBe(0);
      expect(handle().getCurrentTime()).toBe(23.375);

      await act(async () => handle().play(30));
      if (stage === "before") act(metadata);
      await act(async () => audio.dispatchEvent(new Event("canplay")));
      expect(audio.currentTime).toBe(23.375);
      expect(audio.paused).toBe(false);
    }
  );

  it("keeps Space as play/pause on a focused player button", async () => {
    const { audio, handle, metadata, getAllByRole } = setup();
    act(metadata);
    const [skip] = getAllByRole("button", { name: messages.player.skipForward });
    skip.focus();
    expect(document.activeElement).toBe(skip);
    const space = new KeyboardEvent("keydown", {
      key: " ", code: "Space", bubbles: true, cancelable: true,
    });
    await act(async () => { skip.dispatchEvent(space); });
    expect(space.defaultPrevented).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(handle().isPlayRequested()).toBe(true);
  });
});
