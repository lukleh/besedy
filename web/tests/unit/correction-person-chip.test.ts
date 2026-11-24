import { describe, expect, it } from "vitest";
import { initialsOf } from "@/components/correction/person-chip";
import { markerGaps, presenceMarkers } from "@/components/correction/correction-strip";
import type { PresentPerson } from "@/components/correction/correction-types";

function person(userId: string, spanId: string | null, startSeconds: number | null, editing = false): PresentPerson {
  return { userId, name: userId, spanId, ordinal: startSeconds === null ? null : startSeconds / 10, startSeconds, editing };
}

describe("initialsOf", () => {
  it("takes the first and last name", () => {
    expect(initialsOf("Jana Nováková")).toBe("JN");
    expect(initialsOf("Jan Amos Komenský")).toBe("JK");
  });

  it("takes two letters of a single name or of an address part", () => {
    expect(initialsOf("Šárka")).toBe("ŠÁ");
    expect(initialsOf("petr.dvorak")).toBe("PD");
  });

  it("marks a person without a name", () => {
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("presenceMarkers", () => {
  it("puts people on the same segment under one marker, in the order of the recording", () => {
    const markers = presenceMarkers([
      person("petr", "span-9", 90),
      person("jana", "span-2", 20, true),
      person("eva", "span-9", 90),
    ]);

    expect(markers.map((marker) => [marker.spanId, marker.people.map((p) => p.userId)])).toEqual([
      ["span-2", ["jana"]],
      ["span-9", ["petr", "eva"]],
    ]);
  });

  it("leaves out somebody whose page has no segment on screen yet", () => {
    expect(presenceMarkers([person("jana", null, null)])).toEqual([]);
  });
});

describe("markerGaps", () => {
  // An hour-long recording at the narrowest supported width: badges at 0:00,
  // 0:10 and 3:00 are far wider than the strip between them.
  it("gives each marker the share of the strip since the one before it", () => {
    const markers = presenceMarkers([person("eva", "span-18", 180), person("jana", "span-0", 0), person("petr", "span-1", 10)]);

    expect(markers.map((marker) => marker.spanId)).toEqual(["span-0", "span-1", "span-18"]);
    const gaps = markerGaps(markers, 3600);
    expect(gaps[0]).toBe(0);
    expect(gaps[1]).toBeCloseTo(10 / 3600);
    expect(gaps[2]).toBeCloseTo(170 / 3600);
    // The gaps add up to where the last marker is, so nothing is placed twice.
    expect(gaps.reduce((sum, gap) => sum + gap, 0)).toBeCloseTo(180 / 3600);
  });

  it("places nothing on a recording without a length", () => {
    expect(markerGaps(presenceMarkers([person("jana", "span-1", 10)]), 0)).toEqual([0]);
  });
});
