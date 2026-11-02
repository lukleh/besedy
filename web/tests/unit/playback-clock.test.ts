/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackClock } from "@/lib/playback-clock";

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

describe("createPlaybackClock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells subscribers about each new time", () => {
    const clock = createPlaybackClock(5);
    const listener = vi.fn();
    clock.subscribe(listener);

    clock.set(6);
    clock.set(6);
    clock.set(7);

    expect(clock.get()).toBe(7);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest time but tells nobody while the page is hidden", () => {
    const clock = createPlaybackClock();
    const listener = vi.fn();
    clock.subscribe(listener);

    setVisibility("hidden");
    clock.set(1);
    clock.set(2);

    expect(clock.get()).toBe(2);
    expect(listener).not.toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not wake subscribers on show when the time has not moved", () => {
    const clock = createPlaybackClock(3);
    const listener = vi.fn();
    clock.subscribe(listener);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops listening for visibility once the last subscriber leaves", () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    const clock = createPlaybackClock();
    const unsubscribeFirst = clock.subscribe(() => {});
    const unsubscribeSecond = clock.subscribe(() => {});

    unsubscribeFirst();
    expect(removeListener).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    unsubscribeSecond();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
