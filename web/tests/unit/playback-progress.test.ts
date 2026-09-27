import { describe, expect, it } from "vitest";
import {
  isAtPlaybackEnd,
  selectEventPlaybackProgress,
  summarizePlaybackProgress,
} from "@/lib/playback-progress";

describe("playback progress summaries", () => {
  it("calculates a bounded percentage", () => {
    expect(
      summarizePlaybackProgress({
        positionSec: 900,
        durationSec: 3600,
        completedAt: null,
      }),
    ).toEqual({
      positionSec: 900,
      durationSec: 3600,
      percent: 25,
      completed: false,
    });
  });

  it("does not show progress after seeking back to the beginning", () => {
    expect(
      summarizePlaybackProgress({
        positionSec: 0,
        durationSec: 3600,
        completedAt: null,
      }),
    ).toEqual({
      positionSec: 0,
      durationSec: 3600,
      percent: 0,
      completed: false,
    });
  });

  it("uses the furthest alternate recording as event progress", () => {
    const partial = summarizePlaybackProgress({
      positionSec: 1200,
      durationSec: 3600,
      completedAt: null,
    });
    const completed = summarizePlaybackProgress({
      positionSec: 3500,
      durationSec: 3600,
      completedAt: new Date(),
    });

    expect(selectEventPlaybackProgress([partial, completed])).toEqual(completed);
  });
});

describe("isAtPlaybackEnd", () => {
  it("accepts a position floored to whole seconds at the end", () => {
    expect(isAtPlaybackEnd(16350, 16350.231)).toBe(true);
    expect(isAtPlaybackEnd(99, 99.964)).toBe(true);
  });

  it("rejects positions before the tolerance or without a duration", () => {
    expect(isAtPlaybackEnd(98, 100)).toBe(false);
    expect(isAtPlaybackEnd(100, null)).toBe(false);
    expect(isAtPlaybackEnd(100, 0)).toBe(false);
    expect(isAtPlaybackEnd(0, 1)).toBe(false);
  });
});
