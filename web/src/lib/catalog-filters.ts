import type { AccessLevel } from "@/generated/prisma/client";
import { scopeRecordingsForAccess } from "@/lib/policy/recording";
import { parseDateFromString } from "./date-utils";
import type {
  CatalogEntry,
  CatalogFilters,
  EnrichedCatalogEntry,
} from "./catalog-types";
import { EMPTY_FILTER, EMPTY_STRING_FILTER } from "./catalog-types";

export function parseDuration(duration?: string): number | undefined {
  if (!duration) return undefined;

  const match = duration.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;

  const [, hours, minutes, seconds] = match;
  return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined) return "--:--:--";

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function isCatalogEntryReady(
  entry: Pick<CatalogEntry, "isActionable" | "isPublished">,
): boolean {
  return entry.isActionable && entry.isPublished;
}

export function scopeCatalogEntriesForAccess<
  T extends Pick<CatalogEntry, "isActionable" | "isPublished">,
>(entries: T[], accessLevel: AccessLevel | null | undefined): T[] {
  return scopeRecordingsForAccess(entries, accessLevel);
}

export function extractDateParts(entry: EnrichedCatalogEntry): {
  year?: number;
  month?: number;
  day?: number;
} | null {
  if (entry.dateYear || entry.dateMonth || entry.dateDay) {
    return {
      year: entry.dateYear ?? undefined,
      month: entry.dateMonth ?? undefined,
      day: entry.dateDay ?? undefined,
    };
  }
  return parseDateFromString(entry.date);
}

export function applyFilters(
  entries: EnrichedCatalogEntry[],
  filters: CatalogFilters,
): EnrichedCatalogEntry[] {
  let filtered = entries;

  if (filters.status === "ready") {
    filtered = filtered.filter((entry) => isCatalogEntryReady(entry));
  } else if (filters.status === "incomplete") {
    filtered = filtered.filter((entry) => !isCatalogEntryReady(entry));
  } else if (filters.actionableOnly) {
    filtered = filtered.filter((entry) => entry.isActionable);
  }

  if (filters.verified === true) {
    filtered = filtered.filter((entry) => entry.verified);
  } else if (filters.verified === false) {
    filtered = filtered.filter((entry) => !entry.verified);
  }

  if (filters.artist) {
    if (filters.artist === EMPTY_STRING_FILTER) {
      filtered = filtered.filter((entry) => {
        const artist = entry.curatedArtist ?? entry.artist;
        return !artist || artist.trim() === "";
      });
    } else {
      const artistLower = filters.artist.toLowerCase();
      filtered = filtered.filter((entry) =>
        ((entry.curatedArtist ?? entry.artist)?.toLowerCase() || "").includes(artistLower),
      );
    }
  }

  if (filters.album !== null && filters.album !== undefined) {
    if (filters.album === EMPTY_FILTER) {
      filtered = filtered.filter((entry) => entry.albumId === null);
    } else {
      filtered = filtered.filter((entry) => entry.albumId === filters.album);
    }
  }

  if (filters.duration === "short" || filters.duration === "medium" || filters.duration === "long") {
    filtered = filtered.filter((entry) => {
      const durationSeconds = parseDuration(entry.duration);
      if (durationSeconds === undefined) return false;
      const minutes = durationSeconds / 60;
      if (filters.duration === "short") return minutes < 30;
      if (filters.duration === "medium") return minutes >= 30 && minutes < 60;
      return minutes >= 60;
    });
  }

  if (filters.recorder !== null && filters.recorder !== undefined) {
    if (filters.recorder === EMPTY_FILTER) {
      filtered = filtered.filter((entry) => entry.recorderId === null);
    } else {
      filtered = filtered.filter((entry) => entry.recorderId === filters.recorder);
    }
  }

  if (filters.location !== null && filters.location !== undefined) {
    if (filters.location === EMPTY_FILTER) {
      filtered = filtered.filter((entry) => entry.locationId === null);
    } else {
      filtered = filtered.filter((entry) => entry.locationId === filters.location);
    }
  }

  if (filters.part !== null && filters.part !== undefined) {
    if (filters.part === EMPTY_FILTER) {
      filtered = filtered.filter((entry) => entry.part === null);
    } else {
      filtered = filtered.filter((entry) => entry.part === filters.part);
    }
  }

  if (filters.dateYear === EMPTY_FILTER) {
    filtered = filtered.filter((entry) => {
      const parts = extractDateParts(entry);
      return !parts?.year;
    });
  } else if (filters.dateYear) {
    const effectiveDateYear = filters.dateYear;
    const effectiveDateMonth = effectiveDateYear ? filters.dateMonth : null;
    const effectiveDateDay = effectiveDateYear && effectiveDateMonth ? filters.dateDay : null;
    filtered = filtered.filter((entry) => {
      const parts = extractDateParts(entry);
      if (!parts?.year) return false;
      if (parts.year !== effectiveDateYear) return false;
      if (effectiveDateMonth && parts.month !== effectiveDateMonth) return false;
      if (effectiveDateDay && parts.day !== effectiveDateDay) return false;
      return true;
    });
  }

  if (filters.duplicates !== null && filters.duplicates !== undefined) {
    filtered = filtered.filter((entry) => entry.duplicateCount === filters.duplicates);
  }

  return filtered;
}

export function compareStrings(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

export function compareNumbers(a?: number | null, b?: number | null): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return a - b;
}

export function compareNumbersNullFirst(a?: number | null, b?: number | null): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  return a - b;
}
