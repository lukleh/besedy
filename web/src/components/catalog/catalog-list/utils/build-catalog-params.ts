import type {
  StatusFilter,
  DurationFilter,
  VerifiedFilter,
  SortDirection,
  ColumnKey,
} from "../types";
import { DEFAULT_SORT } from "../constants";

export interface CatalogFilterParams {
  /** Identifies the request's catalog; it goes in the path, not the query. */
  activeCatalogId?: string | null;
  statusFilter: StatusFilter;
  durationFilter: DurationFilter;
  verifiedFilter: VerifiedFilter;
  recorderFilter: string;
  locationFilter: string;
  partFilter: string;
  dateYear: string;
  dateMonth: string;
  dateDay: string;
  artistFilter: string;
  albumFilter: string;
  duplicatesFilter: string;
  sortKey: ColumnKey;
  sortDir: SortDirection;
}

/** Recordings list endpoint of one catalog, with optional query params. */
export function catalogRecordingsUrl(
  catalogId: string | null | undefined,
  params: URLSearchParams
): string {
  if (!catalogId) {
    throw new Error("A catalog is required to list its recordings");
  }
  const query = params.toString();
  return `/api/catalogs/${encodeURIComponent(catalogId)}/recordings${query ? `?${query}` : ""}`;
}

/**
 * Builds URLSearchParams for catalog API requests.
 * Shared between useCatalogData and useLoadMore to ensure consistency.
 */
export function buildCatalogParams(
  filters: CatalogFilterParams,
  page: number,
  limit: number
): URLSearchParams {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
  });

  if (filters.statusFilter !== "all") {
    params.set("status", filters.statusFilter);
  }
  if (filters.durationFilter !== "all") {
    params.set("duration", filters.durationFilter);
  }
  if (filters.verifiedFilter === "verified") {
    params.set("verified", "true");
  }
  if (filters.verifiedFilter === "unverified") {
    params.set("verified", "false");
  }
  if (filters.recorderFilter !== "all") {
    params.set("recorder", filters.recorderFilter);
  }
  if (filters.locationFilter !== "all") {
    params.set("location", filters.locationFilter);
  }
  if (filters.partFilter !== "all") {
    params.set("part", filters.partFilter);
  }
  if (filters.dateYear !== "all") {
    params.set("dateYear", filters.dateYear);
  }
  if (filters.dateYear !== "all" && filters.dateMonth !== "all") {
    params.set("dateMonth", filters.dateMonth);
  }
  if (filters.dateYear !== "all" && filters.dateMonth !== "all" && filters.dateDay !== "all") {
    params.set("dateDay", filters.dateDay);
  }
  if (filters.artistFilter !== "all") {
    params.set("artist", filters.artistFilter);
  }
  if (filters.albumFilter !== "all") {
    params.set("album", filters.albumFilter);
  }
  if (filters.duplicatesFilter !== "all") {
    params.set("duplicates", filters.duplicatesFilter);
  }
  if (filters.sortKey !== DEFAULT_SORT.key || filters.sortDir !== DEFAULT_SORT.dir) {
    params.set("sort", filters.sortKey);
    params.set("dir", filters.sortDir);
  }

  return params;
}
