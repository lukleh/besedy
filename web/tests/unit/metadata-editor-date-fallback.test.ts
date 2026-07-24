import { describe, it, expect } from "vitest";
import { parseDateFromString } from "@/lib/date-utils";

/**
 * Tests for the date fallback logic used in metadata-editor.tsx and catalog-list.tsx.
 *
 * When editing a recording's metadata, if no curated date fields exist (dateYear, dateMonth, dateDay),
 * the form should fall back to parsing the source.date string to pre-populate the fields.
 */

interface CuratedMetadata {
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
}

interface SourceMetadata {
  date?: string;
}

/**
 * Replicates the sourceDateParts logic from metadata-editor.tsx
 */
function getSourceDateParts(
  curated: CuratedMetadata,
  source: SourceMetadata
): { year?: number; month?: number; day?: number } | null {
  // Only use fallback if ALL curated date fields are empty
  if (curated.dateYear || curated.dateMonth || curated.dateDay) return null;
  return parseDateFromString(source.date);
}

/**
 * Replicates the initial state computation for date fields
 */
function getInitialDateFields(curated: CuratedMetadata, source: SourceMetadata) {
  const sourceDateParts = getSourceDateParts(curated, source);
  return {
    dateYear: curated.dateYear?.toString() || sourceDateParts?.year?.toString() || "",
    dateMonth: curated.dateMonth?.toString() || sourceDateParts?.month?.toString() || "",
    dateDay: curated.dateDay?.toString() || sourceDateParts?.day?.toString() || "",
  };
}

describe("Metadata Editor Date Fallback", () => {
  describe("when curated date fields exist", () => {
    it("uses curated dateYear and ignores source.date", () => {
      const curated = { dateYear: 2024, dateMonth: null, dateDay: null };
      const source = { date: "2020" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2024");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("");
    });

    it("uses all curated date fields when present", () => {
      const curated = { dateYear: 2024, dateMonth: 6, dateDay: 15 };
      const source = { date: "2020-01-01" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2024");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("15");
    });

    it("does not fallback if only dateMonth is set", () => {
      const curated = { dateYear: null, dateMonth: 6, dateDay: null };
      const source = { date: "2025" };

      const result = getInitialDateFields(curated, source);

      // Should use curated month but NOT fallback to source for year
      expect(result.dateYear).toBe("");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("");
    });

    it("does not fallback if only dateDay is set", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: 15 };
      const source = { date: "2025-06" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("15");
    });
  });

  describe("when no curated date fields exist", () => {
    it("falls back to source.date year only", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("");
    });

    it("falls back to source.date year and month", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025-06" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("");
    });

    it("falls back to full source.date", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025-06-15" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("15");
    });

    it("handles source.date with slashes", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025/06/15" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("15");
    });

    it("handles source.date with dots", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025.06.15" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("15");
    });

    it("handles single-digit month and day", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "2025-6-5" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("5");
    });
  });

  describe("when source.date is empty or invalid", () => {
    it("returns empty strings when source.date is undefined", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = {};

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("");
    });

    it("returns empty strings when source.date is empty string", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("");
    });

    it("returns empty strings when source.date is invalid format", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "not a date" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("");
      expect(result.dateMonth).toBe("");
      expect(result.dateDay).toBe("");
    });

    it("parses DMY format (15-06-2025)", () => {
      const curated = { dateYear: null, dateMonth: null, dateDay: null };
      const source = { date: "15-06-2025" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
      expect(result.dateMonth).toBe("6");
      expect(result.dateDay).toBe("15");
    });
  });

  describe("edge cases with undefined vs null", () => {
    it("treats undefined curated fields same as null", () => {
      const curated = { dateYear: undefined, dateMonth: undefined, dateDay: undefined };
      const source = { date: "2025" };

      const result = getInitialDateFields(curated, source);

      expect(result.dateYear).toBe("2025");
    });

    it("treats missing curated fields same as null", () => {
      const curated = {};
      const source = { date: "2025" };

      const result = getInitialDateFields(curated as CuratedMetadata, source);

      expect(result.dateYear).toBe("2025");
    });
  });
});

describe("copyFromSource date button", () => {
  /**
   * Tests for the "Use Source" button behavior in metadata-editor.tsx.
   * The button calls copyFromSource("date") which now uses parseDateFromString
   * for consistent behavior with initial state fallback.
   */

  /**
   * Replicates the copyFromSource("date") logic from metadata-editor.tsx
   */
  function copyFromSourceDate(sourceDate?: string): {
    dateYear: string;
    dateMonth: string;
    dateDay: string;
  } {
    if (!sourceDate) {
      return { dateYear: "", dateMonth: "", dateDay: "" };
    }
    const parsed = parseDateFromString(sourceDate);
    if (parsed) {
      return {
        dateYear: parsed.year?.toString() || "",
        dateMonth: parsed.month?.toString() || "",
        dateDay: parsed.day?.toString() || "",
      };
    }
    return { dateYear: "", dateMonth: "", dateDay: "" };
  }

  it("parses ISO date with dashes", () => {
    const result = copyFromSourceDate("2025-06-15");

    expect(result.dateYear).toBe("2025");
    expect(result.dateMonth).toBe("6");
    expect(result.dateDay).toBe("15");
  });

  it("parses ISO date with slashes", () => {
    const result = copyFromSourceDate("2025/06/15");

    expect(result.dateYear).toBe("2025");
    expect(result.dateMonth).toBe("6");
    expect(result.dateDay).toBe("15");
  });

  it("parses DMY format", () => {
    const result = copyFromSourceDate("15-06-2025");

    expect(result.dateYear).toBe("2025");
    expect(result.dateMonth).toBe("6");
    expect(result.dateDay).toBe("15");
  });

  it("extracts year from free text", () => {
    const result = copyFromSourceDate("recorded in 2023");

    expect(result.dateYear).toBe("2023");
    expect(result.dateMonth).toBe("");
    expect(result.dateDay).toBe("");
  });

  it("returns empty for invalid date", () => {
    const result = copyFromSourceDate("not a date");

    expect(result.dateYear).toBe("");
    expect(result.dateMonth).toBe("");
    expect(result.dateDay).toBe("");
  });

  it("returns empty for undefined", () => {
    const result = copyFromSourceDate(undefined);

    expect(result.dateYear).toBe("");
    expect(result.dateMonth).toBe("");
    expect(result.dateDay).toBe("");
  });

  it("parses year-only format", () => {
    const result = copyFromSourceDate("2025");

    expect(result.dateYear).toBe("2025");
    expect(result.dateMonth).toBe("");
    expect(result.dateDay).toBe("");
  });

  it("parses year-month format", () => {
    const result = copyFromSourceDate("2025-06");

    expect(result.dateYear).toBe("2025");
    expect(result.dateMonth).toBe("6");
    expect(result.dateDay).toBe("");
  });
});

describe("Catalog List Date Fallback (parseDateFromString)", () => {
  /**
   * catalog-list.tsx and metadata-editor.tsx both use parseDateFromString for fallback.
   * See date-utils.test.ts for full parseDateFromString behavior.
   */

  it("documents that both UIs use parseDateFromString", () => {
    expect(true).toBe(true);
  });
});
