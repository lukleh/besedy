import { describe, it, expect } from "vitest";
import { recordingDateParts } from "@/lib/date-utils";

/**
 * The one rule for which date a recording shows, as the metadata editor,
 * the catalog list's inline editor, the transcript export and the correction
 * header all consume it: the curated parts as a whole when any of them is
 * set, else the date parsed from the source file's tag.
 */
describe("recordingDateParts", () => {
  describe("when curated date fields exist", () => {
    it("uses curated dateYear and ignores the source date", () => {
      expect(
        recordingDateParts({ dateYear: 2024, dateMonth: null, dateDay: null, date: "2020" })
      ).toEqual({ year: 2024, month: undefined, day: undefined });
    });

    it("uses all curated date fields when present", () => {
      expect(
        recordingDateParts({ dateYear: 2024, dateMonth: 6, dateDay: 15, date: "2020-01-01" })
      ).toEqual({ year: 2024, month: 6, day: 15 });
    });

    it("takes a lone curated month whole and ignores the source date", () => {
      expect(
        recordingDateParts({ dateYear: null, dateMonth: 12, dateDay: null, date: "2005-06-15" })
      ).toEqual({ year: undefined, month: 12, day: undefined });
    });

    it("takes a lone curated day whole and ignores the source date", () => {
      expect(
        recordingDateParts({ dateYear: null, dateMonth: null, dateDay: 15, date: "2025-06" })
      ).toEqual({ year: undefined, month: undefined, day: 15 });
    });
  });

  describe("when no curated date fields exist", () => {
    const uncurated = { dateYear: null, dateMonth: null, dateDay: null };

    it("falls back to the source year", () => {
      expect(recordingDateParts({ ...uncurated, date: "2025" })).toEqual({ year: 2025 });
    });

    it("falls back to the source year and month", () => {
      expect(recordingDateParts({ ...uncurated, date: "2025-06" })).toEqual({
        year: 2025,
        month: 6,
      });
    });

    it("falls back to the full source date in ISO, slash, dot and DMY forms", () => {
      for (const date of ["2025-06-15", "2025/06/15", "2025.06.15", "15-06-2025"]) {
        expect(recordingDateParts({ ...uncurated, date })).toEqual({
          year: 2025,
          month: 6,
          day: 15,
        });
      }
    });

    it("handles single-digit month and day", () => {
      expect(recordingDateParts({ ...uncurated, date: "2025-6-5" })).toEqual({
        year: 2025,
        month: 6,
        day: 5,
      });
    });
  });

  describe("when the source date is empty or invalid", () => {
    it("returns null for a missing, empty or unparseable source date", () => {
      expect(recordingDateParts({})).toBeNull();
      expect(recordingDateParts({ date: null })).toBeNull();
      expect(recordingDateParts({ date: "" })).toBeNull();
      expect(recordingDateParts({ date: "not a date" })).toBeNull();
    });
  });

  describe("undefined, null and missing curated fields", () => {
    it("treats them all as unset", () => {
      expect(
        recordingDateParts({ dateYear: undefined, dateMonth: undefined, dateDay: undefined, date: "2025" })
      ).toEqual({ year: 2025 });
      expect(recordingDateParts({ date: "2025" })).toEqual({ year: 2025 });
    });
  });
});
