import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewritePath } from "@/lib/security/path-validation";

const originalMappings = process.env.BESEDY_PATH_MAPPINGS;

function mapWith(mappings: string | undefined): void {
  if (mappings === undefined) {
    delete process.env.BESEDY_PATH_MAPPINGS;
  } else {
    process.env.BESEDY_PATH_MAPPINGS = mappings;
  }
}

describe("rewritePath", () => {
  beforeEach(() => mapWith(undefined));

  afterEach(() => mapWith(originalMappings));

  it("returns the path unchanged without mappings", () => {
    expect(rewritePath("/mnt/data/a.wav")).toBe("/mnt/data/a.wav");
  });

  it("rewrites a path under a mapped prefix and the prefix itself", () => {
    mapWith("/mnt/data=/data/original");
    expect(rewritePath("/mnt/data/a/b.wav")).toBe("/data/original/a/b.wav");
    expect(rewritePath("/mnt/data")).toBe("/data/original");
  });

  it("rewrites a path that ends in a slash", () => {
    mapWith("/mnt/data=/data/original");
    expect(rewritePath("/mnt/data/")).toBe("/data/original/");
  });

  it("matches whole path components only", () => {
    mapWith("/data=/mapped");
    expect(rewritePath("/data2/a.wav")).toBe("/data2/a.wav");
    expect(rewritePath("/data/a.wav")).toBe("/mapped/a.wav");
  });

  it("uses the longest matching prefix whatever the order", () => {
    const nested = "/mnt/data/archive/a.wav";
    mapWith("/mnt/data=/short,/mnt/data/archive=/long");
    expect(rewritePath(nested)).toBe("/long/a.wav");
    mapWith("/mnt/data/archive=/long,/mnt/data=/short");
    expect(rewritePath(nested)).toBe("/long/a.wav");
    expect(rewritePath("/mnt/data/other/a.wav")).toBe("/short/other/a.wav");
  });

  it("splits each mapping on its first equals sign only", () => {
    mapWith("/mnt/a=/data/x=y,/mnt/b=/data/b");
    expect(rewritePath("/mnt/a/f.wav")).toBe("/data/x=y/f.wav");
    expect(rewritePath("/mnt/b/f.wav")).toBe("/data/b/f.wav");
  });

  it("ignores trailing slashes and malformed entries", () => {
    mapWith(" /mnt/data/ = /data/ ,nonsense,=/x,/y=,");
    expect(rewritePath("/mnt/data/a.wav")).toBe("/data/a.wav");
    expect(rewritePath("/y/a.wav")).toBe("/y/a.wav");
  });

  it("does not interpret replacement patterns in the target", () => {
    mapWith("/mnt/data=/data/$&");
    expect(rewritePath("/mnt/data/a.wav")).toBe("/data/$&/a.wav");
  });
});
