import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  loadEnrichedCatalogEntries,
  applyFilters,
  extractDateParts,
  isCatalogEntryReady,
  parseDuration,
  EMPTY_FILTER,
  EMPTY_STRING_FILTER,
  scopeCatalogEntriesForAccess,
  type EnrichedCatalogEntry,
  type CatalogFilters,
} from "@/lib/catalog";
import { resolveActiveGroup } from "@/lib/catalog/resolve-group";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { requiresReadyRecordingScope } from "@/lib/policy/recording";

export const dynamic = "force-dynamic";

function parseNumberParam(value: string | null): number | null {
  if (!value) return null;
  // Handle "empty" as a special filter value
  if (value === "empty") return EMPTY_FILTER;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeTextFilter(value: string | null): string | null {
  if (!value) return null;
  // Handle "empty" as a special filter value
  if (value === "empty") return EMPTY_STRING_FILTER;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface FilterOption<T> {
  value: T;
  count: number;
}

interface FilterOptionsResponse {
  groupId: string;
  totalMatching: number;
  options: {
    recorders: Array<{ id: number; name: string; count: number }>;
    locations: Array<{ id: number; name: string; count: number }>;
    albums: Array<{ id: number; name: string; count: number }>;
    parts: FilterOption<number>[];
    artists: FilterOption<string>[];
    duplicates: FilterOption<number>[];
    years: FilterOption<number>[];
    months: FilterOption<number>[];
    days: FilterOption<number>[];
    statuses: FilterOption<"ready" | "incomplete">[];
    durations: FilterOption<"short" | "medium" | "long">[];
    verified: FilterOption<boolean>[];
  };
}

/**
 * Compute available filter options from entries, excluding the specified filter.
 * This allows showing what options are available if the user selects a value.
 */
function computeOptionsForField<T>(
  entries: EnrichedCatalogEntry[],
  filters: CatalogFilters,
  fieldToExclude: keyof CatalogFilters,
  extractor: (entry: EnrichedCatalogEntry) => T | null | undefined
): Map<T, number> {
  // Apply all filters except the one we're computing options for
  const filtersWithoutField = { ...filters, [fieldToExclude]: undefined };
  const filtered = applyFilters(entries, filtersWithoutField);

  // Count occurrences of each value
  const counts = new Map<T, number>();
  for (const entry of filtered) {
    const value = extractor(entry);
    if (value !== null && value !== undefined) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return counts;
}

/**
 * GET /api/catalog/filter-options - Get available filter values based on current filters
 *
 * Query params (same as /api/catalog):
 * - group: Optional group ID override
 * - status: "ready" | "incomplete"
 * - duration: "short" | "medium" | "long"
 * - verified: "true" | "false"
 * - artist, album: Text filters
 * - recorder, location, part: numeric filters
 * - dateYear, dateMonth, dateDay: hierarchical date filters
 * - duplicates: numeric filter
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const groupOverride = searchParams.get("group");

    // Parse filter params
    const filters: CatalogFilters = {
      status: searchParams.get("status") as "ready" | "incomplete" | null,
      duration: searchParams.get("duration") as "short" | "medium" | "long" | null,
      verified: searchParams.get("verified") === "true" ? true : searchParams.get("verified") === "false" ? false : null,
      recorder: parseNumberParam(searchParams.get("recorder")),
      location: parseNumberParam(searchParams.get("location")),
      part: parseNumberParam(searchParams.get("part")),
      dateYear: parseNumberParam(searchParams.get("dateYear")),
      dateMonth: parseNumberParam(searchParams.get("dateMonth")),
      dateDay: parseNumberParam(searchParams.get("dateDay")),
      artist: normalizeTextFilter(searchParams.get("artist")),
      album: parseNumberParam(searchParams.get("album")),
      duplicates: parseNumberParam(searchParams.get("duplicates")),
      actionableOnly: searchParams.get("actionable") === "true",
    };

    // Require authenticated ACTIVE user
    const userId = await requireAuth();

    // Resolve active group
    const group = await resolveActiveGroup(groupOverride, userId);
    if (!group) {
      return NextResponse.json(
        { error: "No workflow group configured" },
        { status: 404 }
      );
    }

    // Check access to this workflow group
    const capability = await getCatalogCapability(group.id, userId);
    if (!capability.hasAccess) {
      return NextResponse.json(
        { error: "Access denied to this catalog" },
        { status: 403 }
      );
    }

    // LISTENER can only see published items - force the ready-status filter
    const requiresReadyScope = requiresReadyRecordingScope(capability.accessLevel);
    if (requiresReadyScope) {
      filters.status = "ready";
    }

    const enrichedEntries = await loadEnrichedCatalogEntries(group.id);
    const visibleEntries = scopeCatalogEntriesForAccess(
      enrichedEntries,
      capability.accessLevel
    );

    // Load all recorders, locations, and albums for name lookup
    const [allRecorders, allLocations, allAlbums] = await Promise.all([
      prisma.recorder.findMany({ orderBy: { name: "asc" } }),
      prisma.location.findMany({ orderBy: { name: "asc" } }),
      prisma.album.findMany({ orderBy: { name: "asc" } }),
    ]);
    const recorderById = new Map(allRecorders.map((r) => [r.id, r]));
    const locationById = new Map(allLocations.map((l) => [l.id, l]));
    const albumById = new Map(allAlbums.map((a) => [a.id, a]));

    // Apply all filters to get total matching count
    const filteredEntries = applyFilters(visibleEntries, filters);
    const totalMatching = filteredEntries.length;

    // Compute options for each filter field (excluding that field from filters)
    // Recorder options
    const recorderCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "recorder",
      (e) => e.recorderId
    );
    const recorderOptions = Array.from(recorderCounts.entries())
      .map(([id, count]) => {
        const recorder = recorderById.get(id);
        return recorder ? { id, name: recorder.name, count } : null;
      })
      .filter((r): r is { id: number; name: string; count: number } => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Location options
    const locationCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "location",
      (e) => e.locationId
    );
    const locationOptions = Array.from(locationCounts.entries())
      .map(([id, count]) => {
        const location = locationById.get(id);
        return location ? { id, name: location.name, count } : null;
      })
      .filter((l): l is { id: number; name: string; count: number } => l !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Part options
    const partCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "part",
      (e) => e.part
    );
    const partOptions = Array.from(partCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value - b.value);

    // Artist options
    const artistCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "artist",
      (e) => e.artist?.trim() || null
    );
    const artistOptions = Array.from(artistCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));

    // Album options (ID-based like recorder/location)
    const albumCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "album",
      (e) => e.albumId
    );
    const albumOptions = Array.from(albumCounts.entries())
      .map(([id, count]) => {
        const album = albumById.get(id);
        return album ? { id, name: album.name, count } : null;
      })
      .filter((a): a is { id: number; name: string; count: number } => a !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Duplicate count options
    const duplicatesCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "duplicates",
      (e) => e.duplicateCount
    );
    const duplicatesOptions = Array.from(duplicatesCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value - b.value);

    // Status options (ready/incomplete) - empty for LISTENER since they can only see ready
    let statusOptions: FilterOption<"ready" | "incomplete">[] = [];
    if (!requiresReadyScope) {
      const statusCounts = computeOptionsForField(
        visibleEntries,
        filters,
        "status",
        (e): "ready" | "incomplete" => isCatalogEntryReady(e) ? "ready" : "incomplete"
      );
      statusOptions = Array.from(statusCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value));
    }

    // Duration options (short/medium/long)
    const durationCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "duration",
      (e): "short" | "medium" | "long" | null => {
        const seconds = parseDuration(e.duration);
        if (seconds === undefined) return null;
        if (seconds < 30 * 60) return "short";
        if (seconds < 60 * 60) return "medium";
        return "long";
      }
    );
    // Sort in logical order: short, medium, long
    const durationOrder = { short: 0, medium: 1, long: 2 };
    const durationOptions = Array.from(durationCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => durationOrder[a.value] - durationOrder[b.value]);

    // Verified options (true/false)
    const verifiedCounts = computeOptionsForField(
      visibleEntries,
      filters,
      "verified",
      (e) => e.verified
    );
    const verifiedOptions = Array.from(verifiedCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === b.value ? 0 : a.value ? -1 : 1)); // true first

    // Year options (exclude all date filters when computing)
    const yearFilters = { ...filters, dateYear: undefined, dateMonth: undefined, dateDay: undefined };
    const yearFiltered = applyFilters(visibleEntries, yearFilters);
    const yearCounts = new Map<number, number>();
    for (const entry of yearFiltered) {
      const parts = extractDateParts(entry);
      if (parts?.year) {
        yearCounts.set(parts.year, (yearCounts.get(parts.year) || 0) + 1);
      }
    }
    const yearOptions = Array.from(yearCounts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.value - a.value);

    // Month options (only when year is selected, exclude month/day filters)
    let monthOptions: FilterOption<number>[] = [];
    if (filters.dateYear) {
      const monthFilters = { ...filters, dateMonth: undefined, dateDay: undefined };
      const monthFiltered = applyFilters(visibleEntries, monthFilters);
      const monthCounts = new Map<number, number>();
      for (const entry of monthFiltered) {
        const parts = extractDateParts(entry);
        if (parts?.year === filters.dateYear && parts?.month) {
          monthCounts.set(parts.month, (monthCounts.get(parts.month) || 0) + 1);
        }
      }
      monthOptions = Array.from(monthCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);
    }

    // Day options (only when year and month are selected, exclude day filter)
    let dayOptions: FilterOption<number>[] = [];
    if (filters.dateYear && filters.dateMonth) {
      const dayFilters = { ...filters, dateDay: undefined };
      const dayFiltered = applyFilters(visibleEntries, dayFilters);
      const dayCounts = new Map<number, number>();
      for (const entry of dayFiltered) {
        const parts = extractDateParts(entry);
        if (parts?.year === filters.dateYear && parts?.month === filters.dateMonth && parts?.day) {
          dayCounts.set(parts.day, (dayCounts.get(parts.day) || 0) + 1);
        }
      }
      dayOptions = Array.from(dayCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);
    }

    const response: FilterOptionsResponse = {
      groupId: group.id,
      totalMatching,
      options: {
        recorders: recorderOptions,
        locations: locationOptions,
        parts: partOptions,
        artists: artistOptions,
        albums: albumOptions,
        duplicates: duplicatesOptions,
        years: yearOptions,
        months: monthOptions,
        days: dayOptions,
        statuses: statusOptions,
        durations: durationOptions,
        verified: verifiedOptions,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error loading filter options:", error);
    return NextResponse.json(
      { error: "Failed to load filter options" },
      { status: 500 }
    );
  }
}
