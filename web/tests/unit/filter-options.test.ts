import { describe, it, expect } from "vitest";
import {
  applyFilters,
  extractDateParts,
  parseDateFromString,
  scopeCatalogEntriesForAccess,
  type EnrichedCatalogEntry,
} from "@/lib/catalog";

// Helper to create a minimal enriched entry for testing
function createEntry(overrides: Partial<EnrichedCatalogEntry> = {}): EnrichedCatalogEntry {
  return {
    hash: "test-hash",
    hasArchived: true,
    hasMetadata: true,
    isActionable: true,
    isPublished: true,
    curated: false,
    verified: false,
    verifiedAt: null,
    tags: [],
    notes: null,
    recorderId: null,
    recorder: null,
    locationId: null,
    location: null,
    albumId: null,
    album: null,
    part: null,
    duplicateCount: 0,
    dateYear: null,
    dateMonth: null,
    dateDay: null,
    ...overrides,
  };
}

describe("parseDateFromString", () => {
  it("should parse ISO format YYYY-MM-DD", () => {
    expect(parseDateFromString("2024-06-15")).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("should parse ISO format with dots YYYY.MM.DD", () => {
    expect(parseDateFromString("2024.06.15")).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("should parse year-month only YYYY-MM", () => {
    expect(parseDateFromString("2024-06")).toEqual({ year: 2024, month: 6 });
  });

  it("should parse year only YYYY", () => {
    expect(parseDateFromString("2024")).toEqual({ year: 2024 });
  });

  it("should parse DMY format DD-MM-YYYY", () => {
    expect(parseDateFromString("15-06-2024")).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("should extract year from text with embedded date", () => {
    expect(parseDateFromString("recording_2024_audio")).toEqual({ year: 2024 });
  });

  it("should return null for invalid input", () => {
    expect(parseDateFromString(null)).toBeNull();
    expect(parseDateFromString("")).toBeNull();
    expect(parseDateFromString("invalid")).toBeNull();
  });
});

describe("extractDateParts", () => {
  it("should prefer explicit date fields over date string", () => {
    const entry = createEntry({
      dateYear: 2024,
      dateMonth: 6,
      dateDay: 15,
      date: "2000-01-01",
    });
    expect(extractDateParts(entry)).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("should fall back to date string parsing", () => {
    const entry = createEntry({ date: "2024-06-15" });
    expect(extractDateParts(entry)).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("should handle partial date fields", () => {
    const entry = createEntry({ dateYear: 2024 });
    expect(extractDateParts(entry)).toEqual({ year: 2024, month: undefined, day: undefined });
  });
});

describe("applyFilters", () => {
  const entries: EnrichedCatalogEntry[] = [
    createEntry({ hash: "1", isActionable: true, verified: false, recorderId: 1, dateYear: 2024 }),
    createEntry({ hash: "2", isActionable: true, verified: true, recorderId: 1, dateYear: 2024 }),
    createEntry({ hash: "3", isActionable: false, verified: false, recorderId: 2, dateYear: 2023 }),
    createEntry({ hash: "4", isActionable: true, verified: true, recorderId: 2, dateYear: 2023 }),
    createEntry({ hash: "5", isActionable: true, verified: false, artist: "Artist A", dateYear: 2022 }),
    createEntry({ hash: "6", isActionable: true, verified: false, artist: "Artist B", albumId: 1, album: { id: 1, name: "Album X" }, dateYear: 2022 }),
    createEntry({ hash: "7", isActionable: true, verified: false, duration: "00:15:00", dateYear: 2024 }), // 15 min
    createEntry({ hash: "8", isActionable: true, verified: false, duration: "00:45:00", dateYear: 2024 }), // 45 min
    createEntry({ hash: "9", isActionable: true, verified: false, duration: "01:30:00", dateYear: 2024 }), // 90 min
    createEntry({ hash: "10", isActionable: true, verified: false, part: 1, dateYear: 2024 }),
    createEntry({ hash: "11", isActionable: true, verified: false, part: 2, dateYear: 2024 }),
    createEntry({ hash: "12", isActionable: true, verified: false, locationId: 1, dateYear: 2024 }),
    createEntry({ hash: "13", isActionable: true, verified: false, duplicateCount: 3, dateYear: 2024 }),
    createEntry({ hash: "14", isActionable: true, verified: false, title: "My Song", filename: "recording_song.wav", dateYear: 2024 }),
  ];

  describe("status filter", () => {
    it("should filter ready (actionable) entries", () => {
      const result = applyFilters(entries, { status: "ready" });
      expect(result.every((e) => e.isActionable)).toBe(true);
    });

    it("should filter incomplete (non-actionable) entries", () => {
      const result = applyFilters(entries, { status: "incomplete" });
      expect(result.every((e) => !e.isActionable)).toBe(true);
    });

    it("should treat actionable but unpublished entries as incomplete", () => {
      const mixedEntries = [
        createEntry({ hash: "pub", isActionable: true, isPublished: true }),
        createEntry({ hash: "unpub", isActionable: true, isPublished: false }),
      ];
      const ready = applyFilters(mixedEntries, { status: "ready" });
      const incomplete = applyFilters(mixedEntries, { status: "incomplete" });
      expect(ready.map((e) => e.hash)).toEqual(["pub"]);
      expect(incomplete.map((e) => e.hash)).toEqual(["unpub"]);
    });
  });

  describe("actionableOnly filter", () => {
    it("should filter actionable entries when status is not set", () => {
      const result = applyFilters(entries, { actionableOnly: true });
      expect(result.every((e) => e.isActionable)).toBe(true);
      expect(result.length).toBe(13);
    });
  });

  describe("verified filter", () => {
    it("should filter verified entries", () => {
      const result = applyFilters(entries, { verified: true });
      expect(result.every((e) => e.verified)).toBe(true);
      expect(result.length).toBe(2);
    });

    it("should filter unverified entries", () => {
      const result = applyFilters(entries, { verified: false });
      expect(result.every((e) => !e.verified)).toBe(true);
    });
  });

  describe("recorder filter", () => {
    it("should filter by recorder ID", () => {
      const result = applyFilters(entries, { recorder: 1 });
      expect(result.every((e) => e.recorderId === 1)).toBe(true);
      expect(result.length).toBe(2);
    });
  });

  describe("location filter", () => {
    it("should filter by location ID", () => {
      const result = applyFilters(entries, { location: 1 });
      expect(result.every((e) => e.locationId === 1)).toBe(true);
      expect(result.length).toBe(1);
    });
  });

  describe("part filter", () => {
    it("should filter by part number", () => {
      const result = applyFilters(entries, { part: 1 });
      expect(result.every((e) => e.part === 1)).toBe(true);
      expect(result.length).toBe(1);
    });
  });

  describe("artist filter", () => {
    it("should filter by artist (case-insensitive)", () => {
      const result = applyFilters(entries, { artist: "artist a" });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("5");
    });
  });

  describe("album filter", () => {
    it("should filter by album ID", () => {
      const result = applyFilters(entries, { album: 1 });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("6");
    });
  });

  describe("duration filter", () => {
    it("should filter short durations (< 30 min)", () => {
      const result = applyFilters(entries, { duration: "short" });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("7");
    });

    it("should filter medium durations (30-60 min)", () => {
      const result = applyFilters(entries, { duration: "medium" });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("8");
    });

    it("should filter long durations (>= 60 min)", () => {
      const result = applyFilters(entries, { duration: "long" });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("9");
    });
  });

  describe("duplicates filter", () => {
    it("should filter by duplicate count", () => {
      const result = applyFilters(entries, { duplicates: 3 });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("13");
    });
  });

  describe("date filter", () => {
    it("should filter by year", () => {
      const result = applyFilters(entries, { dateYear: 2024 });
      expect(result.every((e) => extractDateParts(e)?.year === 2024)).toBe(true);
    });

    it("should ignore month filter without year", () => {
      const result = applyFilters(entries, { dateMonth: 6 });
      // Should not filter since year is not set
      expect(result.length).toBe(entries.length);
    });

    it("should filter by year and month", () => {
      const entriesWithMonth = [
        createEntry({ hash: "a", dateYear: 2024, dateMonth: 6 }),
        createEntry({ hash: "b", dateYear: 2024, dateMonth: 7 }),
        createEntry({ hash: "c", dateYear: 2023, dateMonth: 6 }),
      ];
      const result = applyFilters(entriesWithMonth, { dateYear: 2024, dateMonth: 6 });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("a");
    });
  });

  describe("duplicates filter", () => {
    it("should filter by duplicate count", () => {
      const result = applyFilters(entries, { duplicates: 3 });
      expect(result.length).toBe(1);
      expect(result[0].hash).toBe("13");
    });
  });

  describe("combined filters", () => {
    it("should apply multiple filters together", () => {
      const result = applyFilters(entries, {
        status: "ready",
        dateYear: 2024,
        verified: false,
      });
      expect(result.every((e) => e.isActionable && extractDateParts(e)?.year === 2024 && !e.verified)).toBe(true);
    });

    it("should return empty array when no entries match", () => {
      const result = applyFilters(entries, {
        recorder: 999, // Non-existent
      });
      expect(result.length).toBe(0);
    });
  });

  describe("empty filters", () => {
    it("should return all entries with empty filter object", () => {
      const result = applyFilters(entries, {});
      expect(result.length).toBe(entries.length);
    });

    it("should return all entries with null filter values", () => {
      const result = applyFilters(entries, {
        status: null,
        verified: null,
        recorder: null,
      });
      expect(result.length).toBe(entries.length);
    });
  });
});

describe("scopeCatalogEntriesForAccess", () => {
  const entries: EnrichedCatalogEntry[] = [
    createEntry({ hash: "published", isActionable: true, isPublished: true }),
    createEntry({ hash: "draft", isActionable: true, isPublished: false }),
    createEntry({ hash: "incomplete", isActionable: false, isPublished: true }),
  ];

  it("keeps all entries for non-listener access", () => {
    expect(scopeCatalogEntriesForAccess(entries, "VIEWER").map((entry) => entry.hash)).toEqual([
      "published",
      "draft",
      "incomplete",
    ]);
  });

  it("keeps only listener-visible entries for listener access", () => {
    expect(scopeCatalogEntriesForAccess(entries, "LISTENER").map((entry) => entry.hash)).toEqual([
      "published",
    ]);
  });
});
