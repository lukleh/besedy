import { describe, expect, it } from "vitest";
import { regionIndexAt, spanAudioRegions } from "@/components/correction/correction-span-audio";
import type { SpanView } from "@/components/correction/correction-types";

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
