import { describe, expect, it } from "vitest";
import { bucketStrip } from "@/components/correction/correction-strip";
import type { StripSpan } from "@/components/correction/correction-types";

function strip(ordinal: number, start: number, end: number, state: StripSpan["state"]): StripSpan {
  return {
    spanId: `span-${ordinal}`,
    ordinal,
    startSeconds: start,
    endSeconds: end,
    state,
    wantsMe: false,
  };
}

describe("bucketStrip", () => {
  it("lays spans out along the recording by time", () => {
    const buckets = bucketStrip(
      [strip(0, 0, 50, "done"), strip(1, 50, 100, "not_reviewed")],
      100,
      10
    );

    expect(buckets.slice(0, 5).every((bucket) => bucket.state === "done")).toBe(true);
    expect(buckets.slice(5).every((bucket) => bucket.state === "not_reviewed")).toBe(true);
    expect(buckets[0].spanId).toBe("span-0");
    expect(buckets[5].spanId).toBe("span-1");
  });

  it("does not let a span ending on a bucket edge colour the next bucket", () => {
    const buckets = bucketStrip([strip(0, 0, 10, "needs_attention"), strip(1, 10, 100, "done")], 100, 10);

    expect(buckets[0].state).toBe("needs_attention");
    expect(buckets[1].state).toBe("done");
  });

  // A stretch only looks finished when everything in it is.
  it("shows the state that still wants somebody when spans share a bucket", () => {
    const buckets = bucketStrip(
      [
        strip(0, 0, 3, "done"),
        strip(1, 3, 6, "needs_second_approval"),
        strip(2, 6, 10, "needs_attention"),
        strip(3, 10, 20, "done"),
      ],
      20,
      2
    );

    expect(buckets[0].state).toBe("needs_attention");
    expect(buckets[1].state).toBe("done");
  });

  it("lands a click on the span that gave the bucket its colour", () => {
    const buckets = bucketStrip(
      [
        strip(0, 0, 3, "done"),
        strip(1, 3, 5, "needs_attention"),
        strip(2, 5, 8, "needs_attention"),
        strip(3, 8, 10, "not_reviewed"),
      ],
      10,
      1
    );

    expect(buckets[0].state).toBe("needs_attention");
    expect(buckets[0].spanId).toBe("span-1");
  });

  it("ranks an unreviewed span above a half-approved one", () => {
    const buckets = bucketStrip([strip(0, 0, 5, "needs_second_approval"), strip(1, 5, 10, "not_reviewed")], 10, 1);
    expect(buckets[0].state).toBe("not_reviewed");
  });

  it("leaves stretches no span covers empty", () => {
    const buckets = bucketStrip([strip(0, 0, 10, "done")], 100, 10);

    expect(buckets[0].state).toBe("done");
    expect(buckets[5]).toEqual({ state: null, spanId: null });
  });

  it("draws nothing for a recording with no length", () => {
    expect(bucketStrip([strip(0, 0, 0, "done")], 0, 4).every((bucket) => bucket.state === null)).toBe(true);
  });
});
