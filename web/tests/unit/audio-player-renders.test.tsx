import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";
import { toProgressStep } from "@/components/player/audio-player-chrome";

// Counts renders of a control that never shows the playback position, and of
// the progress bar, which does.
const renders = vi.hoisted(() => ({ sleepTimer: 0, progress: 0 }));

vi.mock("@/components/player/sleep-timer-button", () => ({
  SleepTimerButton: () => {
    renders.sleepTimer += 1;
    return null;
  },
}));

vi.mock("@/components/ui/slider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/slider")>();
  return {
    Slider: (props: ComponentProps<typeof actual.Slider>) => {
      if (props["aria-label"] === "Playback progress") renders.progress += 1;
      return <actual.Slider {...props} />;
    },
  };
});

vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => ({
    isSupported: false,
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
    progress: "Playback progress",
    volume: "Volume",
    keyboardHints: "Hints",
    reconnecting: "Reconnecting...",
  },
};

function setBufferedEnd(audio: HTMLAudioElement, end: number) {
  Object.defineProperty(audio, "buffered", {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => end },
  });
}

async function renderRecording(duration = 9000) {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AudioPlayer src="https://example.com/audio.mp3" />
    </NextIntlClientProvider>,
  );
  const audio = utils.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { value: duration, configurable: true });
  setBufferedEnd(audio, 60);
  await act(async () => {
    audio.dispatchEvent(new Event("loadedmetadata"));
  });
  return { ...utils, audio };
}

async function reportTime(audio: HTMLAudioElement, time: number) {
  audio.currentTime = time;
  await act(async () => {
    audio.dispatchEvent(new Event("timeupdate"));
  });
}

describe("AudioPlayer renders on time reports", () => {
  afterEach(() => {
    renders.sleepTimer = 0;
    renders.progress = 0;
  });

  it("re-renders only the progress bar, once per second shown", async () => {
    const { audio, container } = await renderRecording();
    await reportTime(audio, 10);
    const sleepTimer = renders.sleepTimer;
    const progress = renders.progress;

    for (const time of [10.25, 10.5, 10.75]) await reportTime(audio, time);
    expect(renders.progress).toBe(progress);

    await reportTime(audio, 11);
    expect(renders.progress).toBe(progress + 1);
    expect(container.textContent).toContain("00:00:11");
    expect(renders.sleepTimer).toBe(sleepTimer);
  });

  it("follows every report on a recording short enough for a second to show", async () => {
    const { audio } = await renderRecording(120);
    await reportTime(audio, 10);
    const progress = renders.progress;

    for (const time of [10.25, 10.5, 10.75]) await reportTime(audio, time);
    expect(renders.progress).toBe(progress + 3);
  });

  it("moves one shown step per arrow key", async () => {
    const { audio, getByRole } = await renderRecording();
    await reportTime(audio, 10);
    const thumb = getByRole("slider", { name: "Playback progress" });

    for (const expected of ["11", "12"]) {
      await act(async () => {
        fireEvent.keyDown(thumb, { key: "ArrowRight" });
      });
      expect(thumb.getAttribute("aria-valuenow")).toBe(expected);
      expect(audio.currentTime).toBe(Number(expected));
    }
  });

  it("renders one buffer indicator, for the layout on screen", async () => {
    const { container } = await renderRecording();
    expect(container.querySelectorAll('[aria-label$="buffered"]')).toHaveLength(1);
  });
});

describe("toProgressStep", () => {
  it("keeps a position on the slider's grid in its own step", () => {
    expect(toProgressStep(3 * 0.12, 0.12)).toBeCloseTo(0.36);
    expect(toProgressStep(0.47, 0.12)).toBeCloseTo(0.36);
    expect(toProgressStep(10.9, 1)).toBe(10);
  });
});
