import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";
import {
  SleepTimerProvider,
  useSleepTimer,
  useSleepTimerTarget,
} from "@/contexts/sleep-timer-context";
import messages from "../../messages/en.json";

vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => ({
    isSupported: false,
    postMessage: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
  }),
}));

type Timer = NonNullable<ReturnType<typeof useSleepTimer>>;

function Probe({ timerRef }: { timerRef: { current: Timer | null } }) {
  timerRef.current = useSleepTimer();
  return null;
}

function OtherTarget({ playing, onFade }: { playing: boolean; onFade: () => () => void }) {
  useSleepTimerTarget(playing, onFade);
  return null;
}

function setup(sleepTimerEnabled?: boolean) {
  const timerRef: { current: Timer | null } = { current: null };
  const otherFade = vi.fn(() => () => {});
  const tree = (enabled: boolean | undefined, otherPlaying = false) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <SleepTimerProvider>
        <Probe timerRef={timerRef} />
        <OtherTarget playing={otherPlaying} onFade={otherFade} />
        <AudioPlayer src="https://example.com/audio.mp3" sleepTimerEnabled={enabled} />
      </SleepTimerProvider>
    </NextIntlClientProvider>
  );
  const view = render(tree(sleepTimerEnabled));
  const audio = view.container.querySelector("audio")!;
  let paused = true;
  Object.defineProperty(audio, "paused", { configurable: true, get: () => paused });
  audio.play = vi.fn(() => {
    paused = false;
    audio.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  audio.pause = vi.fn(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });

  return {
    ...view,
    audio,
    otherFade,
    timer: () => timerRef.current!,
    rerenderPlayer: (enabled: boolean | undefined, otherPlaying = false) =>
      view.rerender(tree(enabled, otherPlaying)),
    play: async () => {
      await act(async () => {
        await audio.play();
        audio.dispatchEvent(new Event("playing"));
      });
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

describe("AudioPlayer sleep timer opt-out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides both sleep controls and leaves an existing timer paused during correction playback", async () => {
    const { container, audio, timer, play } = setup(false);
    expect(container.querySelectorAll('[data-testid="sleep-timer-button"]')).toHaveLength(0);
    act(() => timer().start(1));
    await play();

    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(timer().remainingMs).toBe(60_000);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.volume).toBe(1);
  });

  it("keeps correction playback untouched when another eligible target expires the timer", async () => {
    const { audio, timer, play, rerenderPlayer, otherFade } = setup(false);
    act(() => timer().start(1));
    await play();
    rerenderPlayer(false, true);

    act(() => vi.advanceTimersByTime(60_000 + 5_000));
    expect(otherFade).toHaveBeenCalledTimes(1);
    expect(timer().remainingMs).toBeNull();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.volume).toBe(1);
  });

  it("keeps the default player controls, countdown and fade behavior", async () => {
    const { container, audio, timer, play } = setup();
    expect(container.querySelectorAll('[data-testid="sleep-timer-button"]').length).toBeGreaterThan(0);
    act(() => timer().start(1));
    await play();

    act(() => vi.advanceTimersByTime(30_000));
    expect(timer().remainingMs).toBe(30_000);
    act(() => vi.advanceTimersByTime(30_000 + 2_500));
    expect(audio.volume).toBeCloseTo(0.5, 1);
    act(() => vi.advanceTimersByTime(2_500));
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(timer().remainingMs).toBeNull();
  });

  it("stops participating when the option changes to disabled during playback", async () => {
    const { container, audio, timer, play, rerenderPlayer, otherFade } = setup();
    act(() => timer().start(1));
    await play();
    act(() => vi.advanceTimersByTime(20_000));

    rerenderPlayer(false);
    expect(container.querySelectorAll('[data-testid="sleep-timer-button"]')).toHaveLength(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(timer().remainingMs).toBe(40_000);

    rerenderPlayer(false, true);
    act(() => vi.advanceTimersByTime(40_000 + 5_000));
    expect(otherFade).toHaveBeenCalledTimes(1);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.volume).toBe(1);
  });
});
