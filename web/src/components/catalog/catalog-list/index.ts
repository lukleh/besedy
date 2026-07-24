export { CatalogList } from "./catalog-list";
export type { CatalogListProps } from "./types";

// Export types for consumers who need them
export type {
  CatalogEntry,
  CatalogResponse,
  PaginationInfo,
  ColumnKey,
  StatusFilter,
  DurationFilter,
  VerifiedFilter,
  SortDirection,
} from "./types";

// Export hooks for potential reuse/testing
export { useCatalogFilters, useColumnVisibility, useCatalogData } from "./hooks";
