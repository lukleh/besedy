import { describe, expect, it } from "vitest";
import { initialsOf } from "@/components/correction/person-chip";
import { clusterMarkers, presenceMarkers } from "@/components/correction/correction-strip";
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

describe("clusterMarkers", () => {
  const ids = (clusters: ReturnType<typeof clusterMarkers>) =>
    clusters.map((cluster) => cluster.markers.map((marker) => marker.spanId));

  // An hour-long recording: neighbouring segments are a fraction of a percent apart.
  it("gathers people a few segments apart into one row, each with their own marker", () => {
    const markers = presenceMarkers([person("jana", "span-0", 0), person("petr", "span-1", 10), person("eva", "span-200", 2000)]);

    expect(ids(clusterMarkers(markers, 3600))).toEqual([["span-0", "span-1"], ["span-200"]]);
  });

  it("leaves people far enough apart on their own", () => {
    const markers = presenceMarkers([person("jana", "span-0", 0), person("petr", "span-1", 10)]);

    expect(ids(clusterMarkers(markers, 100))).toEqual([["span-0"], ["span-1"]]);
  });

  it("does not let a chain of near neighbours stretch one cluster along the strip", () => {
    const markers = presenceMarkers([0, 4, 8, 12].map((start) => person(`p${start}`, `span-${start}`, start)));

    expect(ids(clusterMarkers(markers, 100))).toEqual([["span-0", "span-4"], ["span-8", "span-12"]]);
  });
});
