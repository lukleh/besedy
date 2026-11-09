import { DEFAULT_SORT } from "../constants";
import {
  buildCatalogFilterParams,
  type CatalogFilterState,
} from "../filter-state";

export type CatalogFilterParams = Omit<CatalogFilterState, "page">;

/** Recordings list endpoint of one catalog, with optional query params. */
export function catalogRecordingsUrl(
  catalogId: string | null | undefined,
  params: URLSearchParams,
): string {
  if (!catalogId)
    throw new Error("A catalog is required to list its recordings");
  const query = params.toString();
  return `/api/catalogs/${encodeURIComponent(catalogId)}/recordings${query ? `?${query}` : ""}`;
}

export function buildCatalogParams(
  filters: CatalogFilterParams,
  page: number,
  limit: number,
): URLSearchParams {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  buildCatalogFilterParams(filters).forEach((value, key) =>
    params.set(key, value),
  );
  if (
    filters.sortKey !== DEFAULT_SORT.key ||
    filters.sortDir !== DEFAULT_SORT.dir
  ) {
    params.set("sort", filters.sortKey);
    params.set("dir", filters.sortDir);
  }
  return params;
}
