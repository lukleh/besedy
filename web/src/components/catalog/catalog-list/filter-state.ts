import type {
  ColumnKey,
  DurationFilter,
  SortDirection,
  StatusFilter,
  StoredFilters,
  VerifiedFilter,
} from "./types";
import { DEFAULT_SORT, isColumnKey } from "./constants";

export const DEFAULT_FILTERS = {
  status: "all" as StatusFilter,
  duration: "all" as DurationFilter,
  verified: "all" as VerifiedFilter,
  recorder: "all",
  location: "all",
  part: "all",
  dateYear: "all",
  dateMonth: "all",
  dateDay: "all",
  artist: "all",
  album: "all",
  duplicates: "all",
};

export type CatalogFilters = Partial<typeof DEFAULT_FILTERS>;
export type CatalogFilterKey = keyof typeof DEFAULT_FILTERS;
export type CatalogFilterState = typeof DEFAULT_FILTERS & {
  sortKey: ColumnKey;
  sortDir: SortDirection;
  page: number;
};

export const DEFAULT_FILTER_STATE: CatalogFilterState = {
  ...DEFAULT_FILTERS,
  sortKey: DEFAULT_SORT.key,
  sortDir: DEFAULT_SORT.dir,
  page: 1,
};

export const FILTER_KEYS = Object.keys(DEFAULT_FILTERS) as CatalogFilterKey[];

export function restoreCatalogFilters(
  stored: StoredFilters | null,
): CatalogFilterState {
  const state = { ...DEFAULT_FILTER_STATE };
  if (!stored) return state;
  for (const key of FILTER_KEYS) {
    const value = stored[key];
    if (typeof value !== "string" || !value) continue;
    if (key === "status" && !["all", "ready", "incomplete"].includes(value))
      continue;
    if (
      key === "duration" &&
      !["all", "short", "medium", "long"].includes(value)
    )
      continue;
    if (
      key === "verified" &&
      !["all", "verified", "unverified"].includes(value)
    )
      continue;
    Object.assign(state, { [key]: value });
  }
  if (isColumnKey(stored.sortKey)) state.sortKey = stored.sortKey;
  if (stored.sortDir === "asc" || stored.sortDir === "desc")
    state.sortDir = stored.sortDir;
  if (typeof stored.page === "number" && stored.page > 0)
    state.page = stored.page;
  return state;
}

/** The same filter representation serves list requests, facets, and cache identity. */
export function buildCatalogFilterParams(
  filters: CatalogFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (!value || value === "all") continue;
    if (
      key === "dateMonth" &&
      (!filters.dateYear || filters.dateYear === "all")
    )
      continue;
    if (
      key === "dateDay" &&
      (!filters.dateYear ||
        filters.dateYear === "all" ||
        !filters.dateMonth ||
        filters.dateMonth === "all")
    )
      continue;
    params.set(key, key === "verified" ? String(value === "verified") : value);
  }
  return params;
}
