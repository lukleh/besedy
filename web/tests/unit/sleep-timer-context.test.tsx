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
  enabled,
}: {
  playing: boolean;
  onFade: () => () => void;
  enabled?: boolean;
}) {
  useSleepTimerTarget(playing, onFade, enabled);
  return null;
}

function Probe({ timerRef }: { timerRef: { current: Timer | null } }) {
  timerRef.current = useSleepTimer();
  return null;
}

function setup() {
  const timerRef: { current: Timer | null } = { current: null };
  const cancelPrimaryFade = vi.fn();
  const primaryFade = vi.fn(() => cancelPrimaryFade);
  const playerFade = vi.fn(() => () => {});
  const tree = (primaryPlaying: boolean, player: boolean | null, playerEnabled = true) => (
    <StrictMode>
      <SleepTimerProvider>
        <Probe timerRef={timerRef} />
        <Target playing={primaryPlaying} onFade={primaryFade} />
        {player !== null && <Target playing={player} onFade={playerFade} enabled={playerEnabled} />}
      </SleepTimerProvider>
    </StrictMode>
  );
  const view = render(tree(false, null));
  return {
    timer: () => timerRef.current!,
    primaryFade,
    cancelPrimaryFade,
    playerFade,
    rerender: (primaryPlaying: boolean, player: boolean | null, playerEnabled = true) =>
      view.rerender(tree(primaryPlaying, player, playerEnabled)),
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
    const { timer, primaryFade, rerender } = setup();
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    rerender(true, null);
    act(() => vi.advanceTimersByTime(2 * 60 * 60_000));
    expect(primaryFade).not.toHaveBeenCalled();
  });

  it("counts only while something plays, then fades every player once and switches off", () => {
    const { timer, primaryFade, playerFade, rerender } = setup();
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
    expect(primaryFade).not.toHaveBeenCalled();

    rerender(false, true);
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(primaryFade).toHaveBeenCalledTimes(1);
    expect(playerFade).toHaveBeenCalledTimes(1);
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    // Off after running out: further playback does not set it again.
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(playerFade).toHaveBeenCalledTimes(1);
  });

  it("keeps counting when playback moves between registered players", () => {
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

  it("excludes a disabled target from counting and another player's expiration", () => {
    const { timer, playerFade, primaryFade, rerender } = setup();
    rerender(false, true, false);
    act(() => timer().start(15));
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(timer().remainingMs).toBe(15 * 60_000);

    rerender(true, true, false);
    act(() => vi.advanceTimersByTime(15 * 60_000));
    expect(primaryFade).toHaveBeenCalledTimes(1);
    expect(playerFade).not.toHaveBeenCalled();
  });

  it("unregisters a playing target when disabled and registers it again when enabled", () => {
    const { timer, playerFade, rerender } = setup();
    rerender(false, true);
    act(() => timer().start(15));
    act(() => vi.advanceTimersByTime(5 * 60_000));

    rerender(false, true, false);
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(timer().remainingMs).toBe(10 * 60_000);
    expect(playerFade).not.toHaveBeenCalled();

    rerender(false, true);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(playerFade).toHaveBeenCalledTimes(1);
    expect(timer().remainingMs).toBeNull();
  });

  it("stops a running fade when the listener sets the timer again or turns it off", () => {
    const { timer, primaryFade, cancelPrimaryFade, rerender } = setup();
    rerender(true, null);
    act(() => timer().start(15));
    act(() => vi.advanceTimersByTime(15 * 60_000));
    expect(primaryFade).toHaveBeenCalledTimes(1);

    act(() => timer().start(30));
    expect(cancelPrimaryFade).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(primaryFade).toHaveBeenCalledTimes(2);
    act(() => timer().cancel());
    expect(cancelPrimaryFade).toHaveBeenCalledTimes(2);
    // Each fade is cancelled once.
    act(() => timer().cancel());
    expect(cancelPrimaryFade).toHaveBeenCalledTimes(2);
  });

  it("can be cancelled", () => {
    const { timer, primaryFade, rerender } = setup();
    rerender(true, null);
    act(() => timer().start(15));
    act(() => timer().cancel());
    expect(timer().remainingMs).toBeNull();
    expect(timer().minutes).toBeNull();

    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(primaryFade).not.toHaveBeenCalled();
  });
});
