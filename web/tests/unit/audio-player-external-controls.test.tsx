import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";
import type { AudioPlayerHandle, AudioPlayerProps } from "@/components/player/audio-player-types";
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
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AudioPlayer src="https://example.com/audio.mp3" {...props} ref={ref} />
    </NextIntlClientProvider>
  );
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
    fail: () => {
      paused = true;
      audio.dispatchEvent(new Event("pause"));
      setError({ code: 2 });
      audio.dispatchEvent(new Event("error"));
    },
    rejectPlay: (value: boolean) => { rejectPlay = value; },
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
    expect(audio.play).not.toHaveBeenCalled();
    expect(handle().isPlayRequested()).toBe(false);
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

  it("leaves Space on an external button to its native action and keeps body Space playback shortcuts", async () => {
    const { audio, handle, metadata, container } = setup();
    act(metadata);
    const externalButton = document.createElement("button");
    externalButton.type = "button";
    externalButton.textContent = "Play segment";
    container.append(externalButton);
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
});
