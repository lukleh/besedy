import { describe, expect, it } from "vitest";
import {
  PlaybackTracker,
  PlayedIntervals,
  speechRegionsInSeconds,
} from "@/lib/correction/playback-coverage";

describe("played intervals", () => {
  it("merges overlapping and touching intervals", () => {
    const played = new PlayedIntervals();
    played.add(0, 2);
    played.add(1, 3);
    played.add(3, 4);
    played.add(10, 11);
    expect(played.coveredWithin(0, 20)).toBe(5);
  });

  it("measures the share of speech regions heard, ignoring the silence between them", () => {
    const played = new PlayedIntervals();
    played.add(0, 5);
    // Regions 0-5 and 6-13: the first fully, the second not at all.
    expect(played.coverage([[0, 5], [6, 13]])).toBeCloseTo(5 / 12);
    played.add(6, 13);
    expect(played.coverage([[0, 5], [6, 13]])).toBe(1);
  });

  it("counts a span without speech as heard", () => {
    expect(new PlayedIntervals().coverage([])).toBe(1);
  });
});

describe("playback tracker", () => {
  it("counts continuous play and nothing a seek skipped", () => {
    const tracker = new PlaybackTracker();
    for (let t = 0; t <= 4; t += 0.25) tracker.observe(t);
    tracker.observe(9); // a jump forward without a seek event still counts for nothing
    for (let t = 9; t <= 10; t += 0.25) tracker.observe(t);
    expect(tracker.report([[0, 10]]).heardFraction).toBeCloseTo(0.5);
  });

  it("starts a new stretch after an interruption", () => {
    const tracker = new PlaybackTracker();
    tracker.observe(0);
    tracker.observe(1);
    tracker.interrupt();
    tracker.observe(1.2);
    tracker.observe(2);
    expect(tracker.played.coveredWithin(0, 5)).toBeCloseTo(1.8);
  });

  it("ignores time going backwards", () => {
    const tracker = new PlaybackTracker();
    tracker.observe(5);
    tracker.observe(4);
    tracker.observe(4.5);
    expect(tracker.played.coveredWithin(0, 10)).toBeCloseTo(0.5);
  });

  it("reports the rates used over the span, and 1 when it was not played", () => {
    const tracker = new PlaybackTracker();
    tracker.observe(0, 0.8);
    tracker.observe(1, 0.8);
    tracker.observe(20, 1.25);
    tracker.observe(21, 1.25);
    expect(tracker.report([[0, 2]])).toMatchObject({ minPlaybackRate: 0.8, maxPlaybackRate: 0.8 });
    expect(tracker.report([[0, 30]])).toMatchObject({ minPlaybackRate: 0.8, maxPlaybackRate: 1.25 });
    expect(tracker.report([[40, 50]])).toMatchObject({
      heardFraction: 0,
      minPlaybackRate: 1,
      maxPlaybackRate: 1,
    });
  });
});

describe("speech regions in seconds", () => {
  it("converts stored sample regions, and falls back to the span window", () => {
    expect(
      speechRegionsInSeconds({ startSeconds: 0, endSeconds: 13, speechRegions: [[0, 80000], [96000, 208000]] })
    ).toEqual([[0, 5], [6, 13]]);
    expect(speechRegionsInSeconds({ startSeconds: 2, endSeconds: 7, speechRegions: null })).toEqual([[2, 7]]);
  });
});
