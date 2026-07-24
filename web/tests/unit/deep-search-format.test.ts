import { describe, expect, it } from "vitest";
import { formatJobDate } from "@/components/deep-search/deep-search-format";

describe("formatJobDate", () => {
  it("uses the catalog date format with hour and minute for Czech", () => {
    expect(formatJobDate("2026-04-25T07:08:00", "cs", "N/A")).toBe(
      "25. \u20074. 2026 07:08"
    );
  });

  it("uses the catalog date format with hour and minute for English", () => {
    expect(formatJobDate("2026-04-25T07:08:00", "en", "N/A")).toBe(
      "Apr 25, 2026 07:08"
    );
  });

  it("returns the localized fallback for missing or invalid dates", () => {
    expect(formatJobDate(null, "cs", "Není k dispozici")).toBe(
      "Není k dispozici"
    );
    expect(formatJobDate("not-a-date", "en", "Not available")).toBe(
      "Not available"
    );
  });
});
