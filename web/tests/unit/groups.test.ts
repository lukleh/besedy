import { describe, it, expect } from "vitest";
import { formatTimestampLabel } from "@/lib/groups";

describe("formatTimestampLabel", () => {
  it("formats valid timestamp ID to readable label", () => {
    // Note: Output format depends on locale, testing structure
    const result = formatTimestampLabel("20251201_143022");

    // Should contain date parts
    expect(result).toContain("2025");
    expect(result).toContain("Dec");
    expect(result).toContain("1");
    // Should contain time parts (format varies by locale - may be 12 or 24 hour)
    // 14:30 in 12-hour format is 2:30 PM
    expect(result).toMatch(/14:30|2:30/);
  });

  it("handles midnight timestamps", () => {
    const result = formatTimestampLabel("20251225_000000");
    expect(result).toContain("2025");
    expect(result).toContain("Dec");
    expect(result).toContain("25");
  });

  it("handles end-of-day timestamps", () => {
    const result = formatTimestampLabel("20251231_235959");
    expect(result).toContain("2025");
    expect(result).toContain("Dec");
    expect(result).toContain("31");
  });

  it("handles different months", () => {
    const january = formatTimestampLabel("20250115_120000");
    expect(january).toContain("Jan");

    const june = formatTimestampLabel("20250615_120000");
    expect(june).toContain("Jun");

    const october = formatTimestampLabel("20251015_120000");
    expect(october).toContain("Oct");
  });

  it("returns original string for invalid format", () => {
    expect(formatTimestampLabel("invalid")).toBe("invalid");
    expect(formatTimestampLabel("20251201")).toBe("20251201");
    expect(formatTimestampLabel("143022")).toBe("143022");
    expect(formatTimestampLabel("")).toBe("");
  });

  it("returns original string for partial matches", () => {
    // Missing seconds
    expect(formatTimestampLabel("20251201_1430")).toBe("20251201_1430");
    // Wrong separator
    expect(formatTimestampLabel("20251201-143022")).toBe("20251201-143022");
    // Extra characters
    expect(formatTimestampLabel("20251201_143022_extra")).toBe("20251201_143022_extra");
  });

  it("handles various years", () => {
    const past = formatTimestampLabel("20200101_000000");
    expect(past).toContain("2020");

    const future = formatTimestampLabel("20301231_235959");
    expect(future).toContain("2030");
  });
});
