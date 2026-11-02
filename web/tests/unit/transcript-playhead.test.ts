import { describe, expect, it } from "vitest";
import { createTranscriptPlayhead } from "@/lib/transcript-playhead";

describe("transcript playhead index", () => {
  it("finds gaps, endpoints and tied starts without changing display order", () => {
    const segments = [
      { start: 5, end: 8 },
      { start: 0, end: 2 },
      { start: 5, end: 6 },
    ];
    const index = createTranscriptPlayhead(segments);
    expect(index.playheadIndex(-1)).toBe(-1);
    expect(index.activeKey(0)).toBe("1");
    expect(index.activeKey(2)).toBe("");
    expect(index.playheadIndex(3)).toBe(1);
    expect(index.activeKey(5)).toBe("0,2");
    expect(index.playheadIndex(5)).toBe(2);
    expect(index.activeKey(6)).toBe("0");
    expect(index.activeKey(8)).toBe("");
    expect(index.playheadIndex(10)).toBe(2);
    expect(segments.map(({ start }) => start)).toEqual([5, 0, 5]);
  });

  it("handles an empty transcript", () => {
    const index = createTranscriptPlayhead([]);
    expect(index.activeKey(1)).toBe("");
    expect(index.playheadIndex(1)).toBe(-1);
  });

  it("matches interval membership across overlapping and reordered transcripts", () => {
    const segments = [
      { start: 0, end: 20 },
      { start: 1, end: 2 },
      { start: 3, end: 5 },
      { start: 4, end: 10 },
      { start: 4, end: 6 },
      { start: 21, end: 21 },
      { start: 22, end: 23 },
    ];
    for (let shift = 0; shift < segments.length; shift++) {
      const reordered = [...segments.slice(shift), ...segments.slice(0, shift)];
      const index = createTranscriptPlayhead(reordered);
      for (let time = -1; time <= 24; time += 0.5) {
        const expected = reordered.flatMap((segment, i) =>
          time >= segment.start && time < segment.end ? [i] : [],
        );
        expect(index.activeKey(time)).toBe(expected.join(","));
      }
    }
  });
});
