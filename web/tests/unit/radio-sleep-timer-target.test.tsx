import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { RadioSleepTimerTarget } from "@/components/radio/radio-sleep-timer-target";

const { radio, useSleepTimerTarget } = vi.hoisted(() => ({
  radio: {
    isPlaying: true,
    isLoading: false,
    isBuffering: false,
    fadeOutAndPause: () => () => {},
  },
  useSleepTimerTarget: vi.fn(),
}));

vi.mock("@/contexts/radio-mode-context", () => ({
  useRadioMode: () => radio,
}));

vi.mock("@/contexts/sleep-timer-context", () => ({
  useSleepTimerTarget,
}));

describe("RadioSleepTimerTarget", () => {
  it.each([
    [{ isPlaying: true, isLoading: false, isBuffering: false }, true],
    [{ isPlaying: true, isLoading: true, isBuffering: false }, false],
    [{ isPlaying: true, isLoading: false, isBuffering: true }, false],
    [{ isPlaying: false, isLoading: false, isBuffering: false }, false],
  ])("counts only audible radio playback (%o)", (state, counted) => {
    Object.assign(radio, state);
    render(<RadioSleepTimerTarget />);
    expect(useSleepTimerTarget).toHaveBeenLastCalledWith(
      counted,
      radio.fadeOutAndPause,
    );
  });
});
