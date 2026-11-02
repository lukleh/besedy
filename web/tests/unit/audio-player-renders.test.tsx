import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AudioPlayer } from "@/components/player/audio-player";

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

async function renderLongRecording() {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AudioPlayer src="https://example.com/audio.mp3" />
    </NextIntlClientProvider>,
  );
  const audio = utils.container.querySelector("audio")!;
  Object.defineProperty(audio, "duration", { value: 9000, configurable: true });
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
    const { audio, container } = await renderLongRecording();
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
});
