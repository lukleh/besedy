import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import {
  SleepTimerProvider,
  useSleepTimer,
  useSleepTimerTarget,
} from "@/contexts/sleep-timer-context";

type Timer = NonNullable<ReturnType<typeof useSleepTimer>>;

function Target({
  playing,
  onFade,
}: {
  playing: boolean;
  onFade: () => () => void;
}) {
  useSleepTimerTarget(playing, onFade);
  return null;
}

function Probe({ timerRef }: { timerRef: { current: Timer | null } }) {
  timerRef.current = useSleepTimer();
  return null;
}

function setup() {
  const timerRef: { current: Timer | null } = { current: null };
  const cancelRadioFade = vi.fn();
  const radioFade = vi.fn(() => cancelRadioFade);
  const playerFade = vi.fn(() => () => {});
  const tree = (radioPlaying: boolean, player: boolean | null) => (
    <StrictMode>
      <SleepTimerProvider>
        <Probe timerRef={timerRef} />
        <Target playing={radioPlaying} onFade={radioFade} />
        {player !== null && <Target playing={player} onFade={playerFade} />}
      </SleepTimerProvider>
    </StrictMode>
  );
  const view = render(tree(false, null));
  return {
    timer: () => timerRef.current!,
    radioFade,
    cancelRadioFade,
    playerFade,
    rerender: (radioPlaying: boolean, player: boolean | null) =>
      view.rerender(tree(radioPlaying, player)),
  };
}

describe("SleepTimerProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is off by default and does nothing while off", () => {
    const { timer, radioFade, rerender } = setup();
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    rerender(true, null);
    act(() => vi.advanceTimersByTime(2 * 60 * 60_000));
    expect(radioFade).not.toHaveBeenCalled();
  });

  it("counts only while something plays, then fades every player once and switches off", () => {
    const { timer, radioFade, playerFade, rerender } = setup();
    rerender(false, false);
    act(() => timer().start(15));
    expect(timer().minutes).toBe(15);
    expect(timer().remainingMs).toBe(15 * 60_000);

    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(timer().remainingMs).toBe(15 * 60_000);

    rerender(true, false);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(timer().remainingMs).toBe(5 * 60_000);

    rerender(false, false);
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(timer().remainingMs).toBe(5 * 60_000);
    expect(radioFade).not.toHaveBeenCalled();

    rerender(false, true);
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(radioFade).toHaveBeenCalledTimes(1);
    expect(playerFade).toHaveBeenCalledTimes(1);
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    // Off after running out: further playback does not set it again.
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(playerFade).toHaveBeenCalledTimes(1);
  });

  it("keeps counting when radio hands playback to a recording player", () => {
    const { timer, playerFade, rerender } = setup();
    rerender(true, null);
    act(() => timer().start(30));
    act(() => vi.advanceTimersByTime(20 * 60_000));

    rerender(false, true);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(playerFade).toHaveBeenCalledTimes(1);
  });

  it("stops counting when a playing player leaves", () => {
    const { timer, rerender } = setup();
    rerender(false, true);
    act(() => timer().start(15));
    act(() => vi.advanceTimersByTime(5 * 60_000));

    rerender(false, null);
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(timer().remainingMs).toBe(10 * 60_000);
  });

  it("stops a running fade when the listener sets the timer again or turns it off", () => {
    const { timer, radioFade, cancelRadioFade, rerender } = setup();
    rerender(true, null);
    act(() => timer().start(15));
    act(() => vi.advanceTimersByTime(15 * 60_000));
    expect(radioFade).toHaveBeenCalledTimes(1);

    act(() => timer().start(30));
    expect(cancelRadioFade).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(radioFade).toHaveBeenCalledTimes(2);
    act(() => timer().cancel());
    expect(cancelRadioFade).toHaveBeenCalledTimes(2);
    // Each fade is cancelled once.
    act(() => timer().cancel());
    expect(cancelRadioFade).toHaveBeenCalledTimes(2);
  });

  it("can be cancelled", () => {
    const { timer, radioFade, rerender } = setup();
    rerender(true, null);
    act(() => timer().start(15));
    act(() => timer().cancel());
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(radioFade).not.toHaveBeenCalled();
  });
});
