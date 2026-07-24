import { describe, it, expect } from "vitest";
import { cn, trimScanRoot } from "@/lib/utils";

describe("cn (className merge utility)", () => {
  it("merges single class names", () => {
    expect(cn("foo")).toBe("foo");
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    expect(cn("base", true && "conditional")).toBe("base conditional");
    expect(cn("base", false && "conditional")).toBe("base");
  });

  it("merges tailwind classes correctly", () => {
    // Later classes should override earlier conflicting ones
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    expect(cn("p-4", "p-2")).toBe("p-2");
  });

  it("handles arrays of classes", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
    expect(cn(["foo"], ["bar"])).toBe("foo bar");
  });

  it("handles objects with boolean values", () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe("foo baz");
  });

  it("handles undefined and null", () => {
    expect(cn("foo", undefined, "bar")).toBe("foo bar");
    expect(cn("foo", null, "bar")).toBe("foo bar");
  });

  it("handles empty inputs", () => {
    expect(cn()).toBe("");
    expect(cn("")).toBe("");
  });

  it("preserves non-conflicting tailwind utilities", () => {
    expect(cn("flex", "items-center", "gap-2")).toBe("flex items-center gap-2");
  });
});

describe("trimScanRoot", () => {
  it("removes scan root from path", () => {
    expect(trimScanRoot("/data/media/file.wav", "/data/media")).toBe("file.wav");
    expect(trimScanRoot("/data/media/subdir/file.wav", "/data/media")).toBe("subdir/file.wav");
  });

  it("handles trailing slash in scan root", () => {
    expect(trimScanRoot("/data/media/file.wav", "/data/media/")).toBe("file.wav");
  });

  it("returns original path when scan root is not provided", () => {
    expect(trimScanRoot("/data/media/file.wav")).toBe("/data/media/file.wav");
    expect(trimScanRoot("/data/media/file.wav", undefined)).toBe("/data/media/file.wav");
  });

  it("returns original path when path does not start with scan root", () => {
    expect(trimScanRoot("/other/path/file.wav", "/data/media")).toBe("/other/path/file.wav");
  });

  it("returns original path for empty scan root", () => {
    expect(trimScanRoot("/data/media/file.wav", "")).toBe("/data/media/file.wav");
  });

  it("handles path that equals scan root", () => {
    // When the path exactly equals scanRoot, result would be empty string
    // Function returns fullPath in this case
    expect(trimScanRoot("/data/media", "/data/media")).toBe("/data/media");
  });

  it("handles deeply nested paths", () => {
    expect(trimScanRoot("/root/a/b/c/d/file.wav", "/root")).toBe("a/b/c/d/file.wav");
  });

  it("is case-sensitive", () => {
    expect(trimScanRoot("/Data/Media/file.wav", "/data/media")).toBe("/Data/Media/file.wav");
  });
});
