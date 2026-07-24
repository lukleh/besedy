import { describe, it, expect } from "vitest";
import {
  parseDuration,
  formatDuration,
  compareStrings,
  compareNumbers,
  compareNumbersNullFirst,
} from "@/lib/catalog";

describe("parseDuration", () => {
  it("parses valid HH:MM:SS format", () => {
    expect(parseDuration("00:00:00")).toBe(0);
    expect(parseDuration("00:00:30")).toBe(30);
    expect(parseDuration("00:01:00")).toBe(60);
    expect(parseDuration("00:05:30")).toBe(330);
    expect(parseDuration("01:00:00")).toBe(3600);
    expect(parseDuration("01:30:45")).toBe(5445);
    expect(parseDuration("12:34:56")).toBe(45296);
  });

  it("returns undefined for invalid formats", () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("invalid")).toBeUndefined();
    expect(parseDuration("1:2:3")).toBeUndefined(); // Not zero-padded
    expect(parseDuration("00:00")).toBeUndefined(); // Missing seconds
    expect(parseDuration("00:00:00:00")).toBeUndefined(); // Too many parts
  });

  it("handles edge cases", () => {
    expect(parseDuration("99:59:59")).toBe(359999);
    expect(parseDuration("00:00:01")).toBe(1);
  });
});

describe("formatDuration", () => {
  it("formats seconds as HH:MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(30)).toBe("00:00:30");
    expect(formatDuration(60)).toBe("00:01:00");
    expect(formatDuration(330)).toBe("00:05:30");
    expect(formatDuration(3600)).toBe("01:00:00");
    expect(formatDuration(5445)).toBe("01:30:45");
    expect(formatDuration(45296)).toBe("12:34:56");
  });

  it("returns placeholder for undefined", () => {
    expect(formatDuration(undefined)).toBe("--:--:--");
  });

  it("handles large values", () => {
    expect(formatDuration(359999)).toBe("99:59:59");
  });

  it("rounds down fractional seconds", () => {
    expect(formatDuration(30.9)).toBe("00:00:30");
    expect(formatDuration(59.999)).toBe("00:00:59");
  });
});

describe("parseDuration and formatDuration roundtrip", () => {
  it("formats parsed durations back to original", () => {
    const testCases = [
      "00:00:00",
      "00:01:30",
      "01:00:00",
      "12:34:56",
      "23:59:59",
    ];

    for (const duration of testCases) {
      const seconds = parseDuration(duration);
      expect(seconds).toBeDefined();
      expect(formatDuration(seconds)).toBe(duration);
    }
  });
});

describe("compareStrings", () => {
  it("returns 0 for equal strings", () => {
    expect(compareStrings("abc", "abc")).toBe(0);
    expect(compareStrings("ABC", "abc")).toBe(0); // case insensitive
  });

  it("returns negative when a < b", () => {
    expect(compareStrings("abc", "def")).toBeLessThan(0);
    expect(compareStrings("a", "b")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareStrings("def", "abc")).toBeGreaterThan(0);
    expect(compareStrings("z", "a")).toBeGreaterThan(0);
  });

  it("handles numeric strings naturally", () => {
    expect(compareStrings("item2", "item10")).toBeLessThan(0);
    expect(compareStrings("track1", "track2")).toBeLessThan(0);
  });

  it("sorts nulls last", () => {
    expect(compareStrings(null, "abc")).toBeGreaterThan(0);
    expect(compareStrings("abc", null)).toBeLessThan(0);
    expect(compareStrings(undefined, "abc")).toBeGreaterThan(0);
    expect(compareStrings("abc", undefined)).toBeLessThan(0);
  });

  it("returns 0 for both null/undefined", () => {
    expect(compareStrings(null, null)).toBe(0);
    expect(compareStrings(undefined, undefined)).toBe(0);
    expect(compareStrings(null, undefined)).toBe(0);
  });
});

describe("compareNumbers", () => {
  it("returns 0 for equal numbers", () => {
    expect(compareNumbers(5, 5)).toBe(0);
    expect(compareNumbers(0, 0)).toBe(0);
    expect(compareNumbers(-3, -3)).toBe(0);
  });

  it("returns negative when a < b", () => {
    expect(compareNumbers(1, 5)).toBeLessThan(0);
    expect(compareNumbers(-10, 0)).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareNumbers(10, 5)).toBeGreaterThan(0);
    expect(compareNumbers(0, -5)).toBeGreaterThan(0);
  });

  it("sorts nulls last", () => {
    expect(compareNumbers(null, 5)).toBeGreaterThan(0);
    expect(compareNumbers(5, null)).toBeLessThan(0);
    expect(compareNumbers(undefined, 5)).toBeGreaterThan(0);
    expect(compareNumbers(5, undefined)).toBeLessThan(0);
  });

  it("returns 0 for both null/undefined", () => {
    expect(compareNumbers(null, null)).toBe(0);
    expect(compareNumbers(undefined, undefined)).toBe(0);
    expect(compareNumbers(null, undefined)).toBe(0);
  });
});

describe("compareNumbersNullFirst", () => {
  it("returns 0 for equal numbers", () => {
    expect(compareNumbersNullFirst(5, 5)).toBe(0);
    expect(compareNumbersNullFirst(0, 0)).toBe(0);
  });

  it("returns negative when a < b", () => {
    expect(compareNumbersNullFirst(1, 5)).toBeLessThan(0);
    expect(compareNumbersNullFirst(-10, 0)).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareNumbersNullFirst(10, 5)).toBeGreaterThan(0);
    expect(compareNumbersNullFirst(0, -5)).toBeGreaterThan(0);
  });

  it("sorts nulls first (opposite of compareNumbers)", () => {
    expect(compareNumbersNullFirst(null, 5)).toBeLessThan(0);
    expect(compareNumbersNullFirst(5, null)).toBeGreaterThan(0);
    expect(compareNumbersNullFirst(undefined, 5)).toBeLessThan(0);
    expect(compareNumbersNullFirst(5, undefined)).toBeGreaterThan(0);
  });

  it("returns 0 for both null/undefined", () => {
    expect(compareNumbersNullFirst(null, null)).toBe(0);
    expect(compareNumbersNullFirst(undefined, undefined)).toBe(0);
    expect(compareNumbersNullFirst(null, undefined)).toBe(0);
  });

  it("produces correct sort order when used with Array.sort", () => {
    // Note: JavaScript's Array.sort always moves undefined to end regardless of comparator
    const values: (number | null)[] = [3, null, 1, null, 2];
    const sorted = [...values].sort(compareNumbersNullFirst);
    // Nulls should be first, then ascending numbers
    expect(sorted).toEqual([null, null, 1, 2, 3]);
  });
});
