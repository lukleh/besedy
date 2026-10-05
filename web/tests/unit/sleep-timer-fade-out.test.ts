import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fadeOutAndPause, SLEEP_FADE_MS } from "@/lib/sleep-timer/fade-out";

class MockAudio extends EventTarget {
  paused = false;
  ended = false;
  private currentVolume = 0.8;
  /** iOS Safari ignores volume changes from the page. */
  fixedVolume = false;

  get volume() {
    return this.currentVolume;
  }

  set volume(value: number) {
    if (!this.fixedVolume) this.currentVolume = value;
  }

  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
}

function asAudio(audio: MockAudio) {
  return audio as unknown as HTMLAudioElement;
}

describe("fadeOutAndPause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fades the volume out, pauses, and restores the volume", () => {
    const audio = new MockAudio();
    const onFinish = vi.fn();
    fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(SLEEP_FADE_MS / 2);
    expect(audio.volume).toBeCloseTo(0.4, 1);
    expect(audio.pause).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SLEEP_FADE_MS / 2);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.volume).toBe(0.8);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("paused");
  });

  it("stops and restores the volume when paused from elsewhere", () => {
    const audio = new MockAudio();
    const onFinish = vi.fn();
    fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(2_000);
    audio.pause();
    expect(audio.volume).toBe(0.8);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("interrupted");

    vi.advanceTimersByTime(SLEEP_FADE_MS);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.volume).toBe(0.8);
  });

  it("reports a track that ended during the fade", () => {
    const audio = new MockAudio();
    const onFinish = vi.fn();
    fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(1_000);
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new Event("pause"));

    expect(onFinish).toHaveBeenCalledExactlyOnceWith("ended");
    expect(audio.volume).toBe(0.8);
  });

  it("cancels without pausing", () => {
    const audio = new MockAudio();
    const onFinish = vi.fn();
    const cancel = fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(2_000);
    cancel();
    vi.advanceTimersByTime(SLEEP_FADE_MS);

    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.volume).toBe(0.8);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("interrupted");
  });

  it("pauses at once where the volume cannot change", () => {
    const audio = new MockAudio();
    audio.fixedVolume = true;
    const onFinish = vi.fn();
    fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(100);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("paused");
  });

  it("pauses muted audio at once and keeps it muted", () => {
    const audio = new MockAudio();
    audio.volume = 0;
    fadeOutAndPause(asAudio(audio));

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.volume).toBe(0);
  });

  it("leaves paused audio alone", () => {
    const audio = new MockAudio();
    audio.paused = true;
    const onFinish = vi.fn();
    fadeOutAndPause(asAudio(audio), { onFinish });

    vi.advanceTimersByTime(SLEEP_FADE_MS);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });
});
