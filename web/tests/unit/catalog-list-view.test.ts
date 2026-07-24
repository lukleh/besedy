import { describe, expect, it } from "vitest";
import {
  includeSelectedNamedOption,
  normalizeEnumFilter,
} from "@/components/catalog/catalog-list/utils";

describe("catalog list view helpers", () => {
  describe("normalizeEnumFilter", () => {
    it("returns null for empty or non-numeric values", () => {
      expect(normalizeEnumFilter(null)).toBeNull();
      expect(normalizeEnumFilter("")).toBeNull();
      expect(normalizeEnumFilter("   ")).toBeNull();
      expect(normalizeEnumFilter("recorder")).toBeNull();
    });

    it("preserves empty sentinel and numeric ids", () => {
      expect(normalizeEnumFilter("empty")).toBe("empty");
      expect(normalizeEnumFilter("12")).toBe("12");
      expect(normalizeEnumFilter(" 7 ")).toBe("7");
    });
  });

  describe("includeSelectedNamedOption", () => {
    const baseOptions = [
      { id: 1, name: "Alpha", count: 4 },
      { id: 3, name: "Gamma", count: 2 },
    ];
    const allOptions = [
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
      { id: 3, name: "Gamma" },
    ];

    it("returns the existing options for all or empty filters", () => {
      expect(includeSelectedNamedOption(baseOptions, allOptions, "all")).toEqual(
        baseOptions
      );
      expect(
        includeSelectedNamedOption(baseOptions, allOptions, "empty")
      ).toEqual(baseOptions);
    });

    it("returns the existing options when the selected item is already present", () => {
      expect(includeSelectedNamedOption(baseOptions, allOptions, "3")).toEqual(
        baseOptions
      );
    });

    it("appends and sorts a selected option that is missing from the filtered list", () => {
      expect(includeSelectedNamedOption(baseOptions, allOptions, "2")).toEqual([
        { id: 1, name: "Alpha", count: 4 },
        { id: 2, name: "Beta", count: 0 },
        { id: 3, name: "Gamma", count: 2 },
      ]);
    });

    it("ignores unknown selected options", () => {
      expect(includeSelectedNamedOption(baseOptions, allOptions, "99")).toEqual(
        baseOptions
      );
    });
  });
});
