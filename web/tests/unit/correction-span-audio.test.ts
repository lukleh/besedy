import { describe, expect, it } from "vitest";
import { regionIndexAt, spanAudioRegions } from "@/components/correction/correction-span-audio";
import type { SpanView } from "@/components/correction/correction-types";
import { regionIndexForMidpoint } from "@/lib/correction/segmentation";

function span(overrides: Partial<SpanView>): SpanView {
  return {
    id: "span-1",
    ordinal: 0,
    startSeconds: 10,
    endSeconds: 27,
    originalText: "",
    text: "",
    revisionId: "rev-1",
    isEdited: false,
    state: "not_reviewed",
    approverIds: [],
    disapproverIds: [],
    commentCount: 0,
    lastEditedById: null,
    lastEditedAt: null,
    speechRegions: [
      [160000, 297600],
      [307200, 438400],
    ],
    flags: [],
    machineWords: [
      { word: "Dnes", start: 10.4, end: 10.9 },
      { word: "budeme", start: 10.9, end: 11.5 },
    ],
    ...overrides,
  };
}

describe("span audio regions", () => {
  it("counts the machine words in each speech region, so speech without text stands out", () => {
    expect(spanAudioRegions(span({}))).toEqual([
      { start: 10, end: 18.6, wordCount: 2 },
      { start: 19.2, end: 27.4, wordCount: 0 },
    ]);
  });

  it("counts a word whose midpoint falls in a gap in the nearest region, as the segmentation does", () => {
    const words = [
      { word: "Dnes", start: 10.4, end: 10.9 },
      // Midpoint 19.0: 0.4 s after the first region, 0.2 s before the second.
      { word: "mluvit", start: 18.8, end: 19.2 },
    ];
    expect(spanAudioRegions(span({ machineWords: words }))).toEqual([
      { start: 10, end: 18.6, wordCount: 1 },
      { start: 19.2, end: 27.4, wordCount: 1 },
    ]);
  });

  it("uses the span window for spans from before the data contract", () => {
    expect(spanAudioRegions(span({ speechRegions: null, machineWords: [] }))).toEqual([
      { start: 10, end: 27, wordCount: 0 },
    ]);
  });

  it("finds the region at a time, else the next one, else the last", () => {
    const regions = spanAudioRegions(span({}));
    expect(regionIndexAt(regions, 12)).toBe(0);
    expect(regionIndexAt(regions, 18.9)).toBe(1);
    expect(regionIndexAt(regions, 5)).toBe(0);
    expect(regionIndexAt(regions, 40)).toBe(1);
  });
});

describe("regionIndexForMidpoint", () => {
  const regions: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [2, 3],
    [5, 6],
  ];

  it("returns the region holding the midpoint", () => {
    expect(regionIndexForMidpoint(regions, 0)).toBe(0);
    expect(regionIndexForMidpoint(regions, 2.5)).toBe(1);
    expect(regionIndexForMidpoint(regions, 6)).toBe(2);
  });

  it("returns the nearest region for a midpoint in a gap or outside, the earlier on a tie", () => {
    expect(regionIndexForMidpoint(regions, 1.2)).toBe(0);
    expect(regionIndexForMidpoint(regions, 1.5)).toBe(0);
    expect(regionIndexForMidpoint(regions, 4.5)).toBe(2);
    expect(regionIndexForMidpoint(regions, -4)).toBe(0);
    expect(regionIndexForMidpoint(regions, 40)).toBe(2);
  });

  it("returns -1 without regions", () => {
    expect(regionIndexForMidpoint([], 1)).toBe(-1);
  });
});
