import { describe, it, expect } from "vitest";
import { getMonthName, formatPartialDate } from "@/lib/date-format";

describe("getMonthName", () => {
  describe("English locale", () => {
    it("returns full month names", () => {
      expect(getMonthName(1, "en")).toBe("January");
      expect(getMonthName(6, "en")).toBe("June");
      expect(getMonthName(12, "en")).toBe("December");
    });

    it("returns short month names", () => {
      expect(getMonthName(1, "en", true)).toBe("Jan");
      expect(getMonthName(6, "en", true)).toBe("Jun");
      expect(getMonthName(12, "en", true)).toBe("Dec");
    });
  });

  describe("Czech locale", () => {
    it("returns full month names in nominative case (standalone form)", () => {
      // Should be "Leden" (nominative) not "Ledna" (genitive)
      expect(getMonthName(1, "cs")).toBe("Leden");
      expect(getMonthName(2, "cs")).toBe("Únor");
      expect(getMonthName(3, "cs")).toBe("Březen");
      expect(getMonthName(4, "cs")).toBe("Duben");
      expect(getMonthName(5, "cs")).toBe("Květen");
      expect(getMonthName(6, "cs")).toBe("Červen");
      expect(getMonthName(7, "cs")).toBe("Červenec");
      expect(getMonthName(8, "cs")).toBe("Srpen");
      expect(getMonthName(9, "cs")).toBe("Září");
      expect(getMonthName(10, "cs")).toBe("Říjen");
      expect(getMonthName(11, "cs")).toBe("Listopad");
      expect(getMonthName(12, "cs")).toBe("Prosinec");
    });

    it("returns short month names", () => {
      expect(getMonthName(1, "cs", true)).toBe("Led");
      expect(getMonthName(12, "cs", true)).toBe("Pro");
    });
  });

  it("capitalizes month names", () => {
    // date-fns returns lowercase for some locales
    expect(getMonthName(1, "cs")[0]).toBe("L"); // Uppercase
    expect(getMonthName(1, "en")[0]).toBe("J"); // Uppercase
  });

  it("falls back to English for unknown locales", () => {
    expect(getMonthName(1, "unknown")).toBe("January");
  });
});

describe("formatPartialDate", () => {
  describe("full date (year, month, day)", () => {
    it("formats Czech dates with figure space padding", () => {
      // Uses figure space (\u2007) for alignment
      expect(formatPartialDate(2025, 12, 14, "cs")).toBe("14. 12. 2025");
      expect(formatPartialDate(2025, 12, 1, "cs")).toBe("\u20071. 12. 2025");
      expect(formatPartialDate(2025, 6, 1, "cs")).toBe("\u20071. \u20076. 2025");
      expect(formatPartialDate(2005, 6, 18, "cs")).toBe("18. \u20076. 2005");
    });

    it("formats English dates with month name and figure space padding", () => {
      expect(formatPartialDate(2025, 12, 14, "en")).toBe("Dec 14, 2025");
      // Uses figure space (\u2007) for single-digit day alignment
      expect(formatPartialDate(2025, 6, 1, "en")).toBe("Jun \u20071, 2025");
      expect(formatPartialDate(2024, 3, 22, "en")).toBe("Mar 22, 2024");
    });
  });

  describe("partial date (year and month only)", () => {
    it("formats Czech dates with capitalized month name", () => {
      expect(formatPartialDate(2025, 3, null, "cs")).toBe("Březen 2025");
      expect(formatPartialDate(2025, 12, undefined, "cs")).toBe("Prosinec 2025");
    });

    it("formats English dates with month name", () => {
      expect(formatPartialDate(2025, 3, null, "en")).toBe("March 2025");
      expect(formatPartialDate(2025, 12, undefined, "en")).toBe("December 2025");
    });
  });

  describe("year only", () => {
    it("returns just the year", () => {
      expect(formatPartialDate(2025, null, null, "cs")).toBe("2025");
      expect(formatPartialDate(2025, undefined, undefined, "en")).toBe("2025");
    });
  });

  describe("empty date", () => {
    it("returns empty string when no date parts provided", () => {
      expect(formatPartialDate(null, null, null, "cs")).toBe("");
      expect(formatPartialDate(undefined, undefined, undefined, "en")).toBe("");
    });
  });

  it("falls back to English for unknown locales", () => {
    expect(formatPartialDate(2025, 12, 14, "unknown")).toBe("Dec 14, 2025");
  });
});
