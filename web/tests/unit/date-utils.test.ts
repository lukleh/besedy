import { describe, it, expect } from "vitest";
import { parseDateFromString } from "@/lib/date-utils";

describe("parseDateFromString", () => {
  describe("ISO format (YYYY-MM-DD)", () => {
    it("parses full ISO date with dashes", () => {
      expect(parseDateFromString("2025-06-15")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses ISO date with slashes", () => {
      expect(parseDateFromString("2025/06/15")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses ISO date with dots", () => {
      expect(parseDateFromString("2025.06.15")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses single-digit month and day", () => {
      expect(parseDateFromString("2025-1-5")).toEqual({
        year: 2025,
        month: 1,
        day: 5,
      });
    });
  });

  describe("year-month format (YYYY-MM)", () => {
    it("parses year-month with dashes", () => {
      expect(parseDateFromString("2025-06")).toEqual({
        year: 2025,
        month: 6,
      });
    });

    it("parses year-month with slashes", () => {
      expect(parseDateFromString("2025/12")).toEqual({
        year: 2025,
        month: 12,
      });
    });

    it("parses single-digit month", () => {
      expect(parseDateFromString("2025-3")).toEqual({
        year: 2025,
        month: 3,
      });
    });
  });

  describe("year only format (YYYY)", () => {
    it("parses four-digit year", () => {
      expect(parseDateFromString("2025")).toEqual({ year: 2025 });
    });

    it("parses year 2000", () => {
      expect(parseDateFromString("2000")).toEqual({ year: 2000 });
    });

    it("parses year 1999", () => {
      expect(parseDateFromString("1999")).toEqual({ year: 1999 });
    });
  });

  describe("DMY format (DD-MM-YYYY)", () => {
    it("parses DMY date with dashes", () => {
      expect(parseDateFromString("15-06-2025")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses DMY date with slashes", () => {
      expect(parseDateFromString("15/06/2025")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses DMY date with dots", () => {
      expect(parseDateFromString("15.06.2025")).toEqual({
        year: 2025,
        month: 6,
        day: 15,
      });
    });

    it("parses single-digit day and month", () => {
      expect(parseDateFromString("5-3-2025")).toEqual({
        year: 2025,
        month: 3,
        day: 5,
      });
    });
  });

  describe("fallback year extraction", () => {
    it("extracts year from text with embedded year", () => {
      expect(parseDateFromString("recorded in 2023")).toEqual({ year: 2023 });
    });

    it("extracts first matching year", () => {
      expect(parseDateFromString("2020-2025")).toEqual({ year: 2020 });
    });

    it("only matches years starting with 19 or 20", () => {
      expect(parseDateFromString("year 1850")).toBeNull();
      expect(parseDateFromString("year 2150")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for null input", () => {
      expect(parseDateFromString(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(parseDateFromString(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseDateFromString("")).toBeNull();
    });

    it("returns null for whitespace only", () => {
      expect(parseDateFromString("   ")).toBeNull();
    });

    it("trims whitespace before parsing", () => {
      expect(parseDateFromString("  2025  ")).toEqual({ year: 2025 });
    });

    it("returns null for non-date string without year", () => {
      expect(parseDateFromString("no date here")).toBeNull();
    });
  });
});
