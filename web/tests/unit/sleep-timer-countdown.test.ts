import { describe, expect, it } from "vitest";
import { createSleepCountdown } from "@/lib/sleep-timer/countdown";

function setup() {
  let time = 1_000_000;
  const countdown = createSleepCountdown(() => time);
  return {
    countdown,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("createSleepCountdown", () => {
  it("is off until started", () => {
    const { countdown, advance } = setup();
    countdown.setRunning(true);
    advance(60_000);

    expect(countdown.tick()).toBe(false);
    expect(countdown.remainingMs()).toBeNull();
  });

  it("counts down only while running", () => {
    const { countdown, advance } = setup();
    countdown.start(10_000);
    advance(5_000);
    expect(countdown.tick()).toBe(false);
    expect(countdown.remainingMs()).toBe(10_000);

    countdown.setRunning(true);
    advance(3_000);
    countdown.setRunning(false);
    // Paused time does not count, and the playing time up to the pause does.
    advance(60_000);
    expect(countdown.remainingMs()).toBe(7_000);

    countdown.setRunning(true);
    advance(2_000);
    countdown.tick();
    expect(countdown.remainingMs()).toBe(5_000);
  });

  it("catches up on a late tick", () => {
    const { countdown, advance } = setup();
    countdown.setRunning(true);
    countdown.start(30_000);
    // A throttled background tab ticks rarely.
    advance(29_000);
    expect(countdown.tick()).toBe(false);
    expect(countdown.remainingMs()).toBe(1_000);
  });

  it("runs out once and then stays off", () => {
    const { countdown, advance } = setup();
    countdown.setRunning(true);
    countdown.start(10_000);
    advance(12_000);

    expect(countdown.tick()).toBe(true);
    expect(countdown.remainingMs()).toBeNull();

    advance(60_000);
    expect(countdown.tick()).toBe(false);
    countdown.setRunning(false);
    countdown.setRunning(true);
    advance(60_000);
    expect(countdown.tick()).toBe(false);
    expect(countdown.remainingMs()).toBeNull();
  });

  it("switches off when it runs out as playback stops", () => {
    const { countdown, advance } = setup();
    countdown.setRunning(true);
    countdown.start(10_000);
    advance(10_000);
    countdown.setRunning(false);

    expect(countdown.remainingMs()).toBeNull();
    countdown.setRunning(true);
    advance(1_000);
    expect(countdown.tick()).toBe(false);
  });

  it("starts over and cancels", () => {
    const { countdown, advance } = setup();
    countdown.setRunning(true);
    countdown.start(10_000);
    advance(4_000);
    countdown.start(20_000);
    countdown.tick();
    expect(countdown.remainingMs()).toBe(20_000);

    countdown.cancel();
    advance(30_000);
    expect(countdown.tick()).toBe(false);
    expect(countdown.remainingMs()).toBeNull();
  });
});
