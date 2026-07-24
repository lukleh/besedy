import { NextRequest, NextResponse } from "next/server";
import {
  loadEnrichedCatalogEntries,
  parseDuration,
  applyFilters,
  extractDateParts,
  compareStrings,
  compareNumbers,
  compareNumbersNullFirst,
  isCatalogEntryReady,
  scopeCatalogEntriesForAccess,
  type EnrichedCatalogEntry,
  type CatalogFilters,
} from "@/lib/catalog";
import { resolveActiveGroup } from "@/lib/catalog/resolve-group";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { logCatalogViewed, logAccessDenied } from "@/lib/audit/logger";
import { requiresReadyRecordingScope } from "@/lib/policy/recording";
import { toCatalogEntryResponse } from "@/types/catalog";

export const dynamic = "force-dynamic";

type SortDirection = "asc" | "desc";
type SortKey =
  | "title"
  | "date"
  | "artist"
  | "album"
  | "duration"
  | "status"
  | "recorder"
  | "location"
  | "part"
  | "verified"
  | "duplicates";

const SORT_KEYS: SortKey[] = [
  "title",
  "date",
  "artist",
  "album",
  "duration",
  "status",
  "recorder",
  "location",
  "part",
  "verified",
  "duplicates",
];

const DEFAULT_SORT: { key: SortKey; dir: SortDirection } = {
  key: "date",
  dir: "desc",
};

function isSortKey(value: string | null): value is SortKey {
  return !!value && SORT_KEYS.includes(value as SortKey);
}

// Special string value to indicate "filter for empty/null values"
export const EMPTY_STRING_FILTER = "__empty__";

function normalizeTextFilter(value: string | null): string | null {
  if (!value) return null;
  // Handle "empty" as a special filter value
  if (value === "empty") return EMPTY_STRING_FILTER;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

// Special value to indicate "filter for empty/null values"
export const EMPTY_FILTER = -1;

function parseNumberParam(value: string | null): number | null {
  if (!value) return null;
  // Handle "empty" as a special filter value
  if (value === "empty") return EMPTY_FILTER;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * GET /api/catalog - List catalog entries for the active group
 *
 * Naming note: this singular endpoint serves paginated recording-entry browsing
 * within one resolved workflow group. The plural `/api/catalogs` endpoint lists
 * workflow groups themselves and handles catalog-management CRUD.
 *
 * Query params:
 * - group: Optional group ID override
 * - actionable: If "true", only return entries that exist in both catalogs
 * - verified: If "true", only return verified entries; if "false", only unverified
 * - artist, album: Text filters (case-insensitive contains)
 * - status: "ready" | "incomplete"
 * - duration: "short" | "medium" | "long"
 * - recorder, location, part: numeric filters
 * - dateYear, dateMonth, dateDay: hierarchical date filters
 * - sort: column key
 * - dir: "asc" | "desc"
 * - page: Page number (1-indexed, default: 1)
 * - limit: Entries per page (default: 50, max: 200, use 0 for all)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const groupOverride = searchParams.get("group");
    const actionableOnly = searchParams.get("actionable") === "true";
    const verifiedFilter = searchParams.get("verified"); // "true", "false", or null
    const statusFilter = searchParams.get("status"); // "ready" | "incomplete" | null
    const durationFilter = searchParams.get("duration"); // "short" | "medium" | "long" | null
    const artistFilter = normalizeTextFilter(searchParams.get("artist"));
    const albumFilter = parseNumberParam(searchParams.get("album"));
    const recorderFilter = parseNumberParam(searchParams.get("recorder"));
    const locationFilter = parseNumberParam(searchParams.get("location"));
    const partFilter = parseNumberParam(searchParams.get("part"));
    const dateYearFilter = parseNumberParam(searchParams.get("dateYear"));
    const dateMonthFilter = parseNumberParam(searchParams.get("dateMonth"));
    const dateDayFilter = parseNumberParam(searchParams.get("dateDay"));
    const duplicatesFilter = parseNumberParam(searchParams.get("duplicates"));
    const sortKey = isSortKey(searchParams.get("sort"))
      ? (searchParams.get("sort") as SortKey)
      : DEFAULT_SORT.key;
    const sortDirParam = searchParams.get("dir");
    const sortDir: SortDirection =
      sortDirParam === "asc" || sortDirParam === "desc"
        ? sortDirParam
        : DEFAULT_SORT.dir;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limitParam = parseInt(searchParams.get("limit") || "50", 10);
    const limit = limitParam === 0 ? Infinity : Math.min(200, Math.max(1, limitParam));

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
      await logAccessDenied(userId, "catalog", group.id, {
        reason: "No access grant",
      });
      return NextResponse.json(
        { error: "Access denied to this catalog" },
        { status: 403 }
      );
    }

    // LISTENER can only see published items - force the ready-status filter
    // Other filters (recorder, location, date, etc.) still apply normally
    let effectiveStatusFilter = statusFilter;
    if (requiresReadyRecordingScope(capability.accessLevel)) {
      effectiveStatusFilter = "ready";
    }

    const enrichedEntries = await loadEnrichedCatalogEntries(group.id);
    const visibleEntries = scopeCatalogEntriesForAccess(
      enrichedEntries,
      capability.accessLevel
    );

    const totalAll = visibleEntries.length;

    // Build filter options from the same visibility-scoped dataset used for rows.
    const partsSet = new Set<number>();
    const datePartsMap = new Map<string, { year: number; month: number | null; day: number | null }>();
    for (const entry of visibleEntries) {
      if (entry.part !== null && entry.part !== undefined) partsSet.add(entry.part);
      const dateParts = extractDateParts(entry);
      if (dateParts?.year) {
        const key = `${dateParts.year}-${dateParts.month ?? "00"}-${dateParts.day ?? "00"}`;
        if (!datePartsMap.has(key)) {
          datePartsMap.set(key, {
            year: dateParts.year,
            month: dateParts.month ?? null,
            day: dateParts.day ?? null,
          });
        }
      }
    }

    // Build filters object for shared filtering logic
    const filters: CatalogFilters = {
      status: effectiveStatusFilter === "ready" || effectiveStatusFilter === "incomplete" ? effectiveStatusFilter : null,
      duration: durationFilter === "short" || durationFilter === "medium" || durationFilter === "long" ? durationFilter : null,
      verified: verifiedFilter === "true" || verifiedFilter === "verified" ? true : verifiedFilter === "false" || verifiedFilter === "unverified" ? false : null,
      artist: artistFilter,
      album: albumFilter,
      recorder: recorderFilter,
      location: locationFilter,
      part: partFilter,
      dateYear: dateYearFilter,
      dateMonth: dateMonthFilter,
      dateDay: dateDayFilter,
      duplicates: duplicatesFilter,
      actionableOnly,
    };

    // Apply filters using shared logic
    const filteredEntries = applyFilters(visibleEntries, filters);

    // Sorting
    // Helper to compare dates as numeric keys (nulls always last)
    const compareDates = (
      a: EnrichedCatalogEntry,
      b: EnrichedCatalogEntry,
      direction: SortDirection
    ): number => {
      const aParts = extractDateParts(a);
      const bParts = extractDateParts(b);
      const aKey = aParts?.year
        ? (aParts.year * 10000) + (aParts.month ?? 0) * 100 + (aParts.day ?? 0)
        : null;
      const bKey = bParts?.year
        ? (bParts.year * 10000) + (bParts.month ?? 0) * 100 + (bParts.day ?? 0)
        : null;
      if (aKey === null || aKey === undefined) {
        return bKey === null || bKey === undefined ? 0 : 1;
      }
      if (bKey === null || bKey === undefined) {
        return -1;
      }
      const diff = aKey - bKey;
      return direction === "asc" ? diff : -diff;
    };

    const sortMultiplier = sortDir === "asc" ? 1 : -1;
    filteredEntries.sort((a, b) => {
      // Sort by date: user direction for date, always ascending for part
      if (sortKey === "date") {
        const dateCmp = compareDates(a, b, sortDir);
        if (dateCmp !== 0) return dateCmp;
        // Secondary: part always ascending (nulls first)
        const partCmp = compareNumbersNullFirst(a.part ?? null, b.part ?? null);
        if (partCmp !== 0) return partCmp;
        // Tiebreaker: hash
        return compareStrings(a.hash, b.hash);
      }

      // Sort by part: user direction, no date secondary
      if (sortKey === "part") {
        const partCmp = compareNumbers(a.part ?? null, b.part ?? null);
        if (partCmp !== 0) return partCmp * sortMultiplier;
        // Tiebreaker: hash
        return compareStrings(a.hash, b.hash);
      }

      // All other columns: primary sort, then date desc, then part asc
      let primaryCmp = 0;
      switch (sortKey) {
        case "title": {
          const aValue = a.title || a.filename || a.hash;
          const bValue = b.title || b.filename || b.hash;
          primaryCmp = compareStrings(aValue, bValue);
          break;
        }
        case "artist":
          primaryCmp = compareStrings(a.artist, b.artist);
          break;
        case "album":
          primaryCmp = compareStrings(a.album?.name, b.album?.name);
          break;
        case "duration": {
          const aSeconds = parseDuration(a.duration);
          const bSeconds = parseDuration(b.duration);
          primaryCmp = compareNumbers(aSeconds, bSeconds);
          break;
        }
        case "status":
          primaryCmp = compareNumbers(
            isCatalogEntryReady(a) ? 1 : 0,
            isCatalogEntryReady(b) ? 1 : 0
          );
          break;
        case "recorder":
          primaryCmp = compareStrings(a.recorder?.name, b.recorder?.name);
          break;
        case "location":
          primaryCmp = compareStrings(a.location?.name, b.location?.name);
          break;
        case "verified":
          primaryCmp = compareNumbers(a.verified ? 1 : 0, b.verified ? 1 : 0);
          break;
        case "duplicates":
          primaryCmp = compareNumbers(a.duplicateCount, b.duplicateCount);
          break;
        default:
          primaryCmp = 0;
      }
      if (primaryCmp !== 0) return primaryCmp * sortMultiplier;

      // Secondary: date descending (newest first)
      const dateCmp = compareDates(a, b, "desc");
      if (dateCmp !== 0) return dateCmp;

      // Tertiary: part ascending (nulls first)
      const partCmp = compareNumbersNullFirst(a.part ?? null, b.part ?? null);
      if (partCmp !== 0) return partCmp;

      // Final tiebreaker: hash
      return compareStrings(a.hash, b.hash);
    });

    // Calculate pagination
    const total = filteredEntries.length;
    const totalPages = limit === Infinity ? 1 : Math.ceil(total / limit);
    const startIndex = limit === Infinity ? 0 : (page - 1) * limit;
    const endIndex = limit === Infinity ? total : startIndex + limit;
    const paginatedEntries = filteredEntries.slice(startIndex, endIndex);

    // Log catalog access
    await logCatalogViewed(userId, group.id, { entryCount: filteredEntries.length });

    return NextResponse.json({
      groupId: group.id,
      groupLabel: group.label,
      lastModifiedAt: group.updatedAt?.toISOString() ?? group.createdAt.toISOString(),
      totalAll,
      total,
      actionable: visibleEntries.filter((e) => e.isActionable).length,
      verified: visibleEntries.filter((e) => e.verified).length,
      entries: paginatedEntries.map(toCatalogEntryResponse),
      filters: {
        parts: Array.from(partsSet).sort((a, b) => a - b),
        dateParts: Array.from(datePartsMap.values()).sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          const aMonth = a.month ?? 0;
          const bMonth = b.month ?? 0;
          if (aMonth !== bMonth) return aMonth - bMonth;
          const aDay = a.day ?? 0;
          const bDay = b.day ?? 0;
          return aDay - bDay;
        }),
      },
      pagination: {
        page,
        limit: limit === Infinity ? total : limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      canDownload: capability.canDownload,
      canEditMetadata: capability.canEditMetadata,
      canBatchEditMetadata: capability.canBatchEditMetadata,
      canManageAccess: capability.canManageAccess,
      accessLevel: capability.accessLevel,
      canUseRagSearch: capability.canUseRagSearch,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error loading catalog:", error);
    return NextResponse.json(
      { error: "Failed to load catalog" },
      { status: 500 }
    );
  }
}
