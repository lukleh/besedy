import type { ColumnConfig, ColumnKey, SortDirection, StoredFilters } from "./types";

export const COLUMNS: ColumnConfig[] = [
  { key: "title", label: "Title / Filename", defaultVisible: true },
  { key: "date", label: "Date", defaultVisible: true },
  { key: "part", label: "Part", defaultVisible: true },
  { key: "recorder", label: "Recorder", defaultVisible: true },
  { key: "location", label: "Location", defaultVisible: true },
  { key: "duration", label: "Duration", defaultVisible: false },
  { key: "artist", label: "Artist", defaultVisible: false },
  { key: "album", label: "Album", defaultVisible: false },
  { key: "status", label: "Status", defaultVisible: true },
  { key: "verified", label: "Verified", defaultVisible: false },
  { key: "duplicates", label: "Duplicates", defaultVisible: false },
  { key: "offline", label: "Offline", defaultVisible: true },
];

export const DEFAULT_SORT: { key: ColumnKey; dir: SortDirection } = {
  key: "date",
  dir: "desc",
};

export const STORAGE_KEY = "besedy-catalog-columns";
export const FILTER_STORAGE_KEY_PREFIX = "besedy-catalog-filters-";

export function isColumnKey(value: string | null | undefined): value is ColumnKey {
  return !!value && COLUMNS.some((column) => column.key === value);
}

export function getDefaultVisibility(): Record<ColumnKey, boolean> {
  return COLUMNS.reduce((acc, col) => {
    acc[col.key] = col.defaultVisible;
    return acc;
  }, {} as Record<ColumnKey, boolean>);
}

/**
 * Get default column visibility for a specific access level.
 * LISTENER: status column hidden by default (all items are published)
 * Others: standard defaults
 */
export function getDefaultVisibilityForRole(accessLevel: string | undefined): Record<ColumnKey, boolean> {
  const defaults = getDefaultVisibility();
  if (accessLevel === "LISTENER") {
    // LISTENER only sees published items, so status column is meaningless by default
    defaults.status = false;
  }
  return defaults;
}

export function getDefaultVisibilityForRoleWithAccess(
  accessLevel: string | undefined
): Record<ColumnKey, boolean> {
  return getDefaultVisibilityForRole(accessLevel);
}

export function hasNonDefaultColumns(
  current: Record<ColumnKey, boolean>,
  accessLevel?: string
): boolean {
  const defaults = getDefaultVisibilityForRoleWithAccess(accessLevel);
  return COLUMNS.some((col) => current[col.key] !== defaults[col.key]);
}

export function loadColumnVisibility(
  accessLevel?: string
): Record<ColumnKey, boolean> {
  const defaults = getDefaultVisibilityForRoleWithAccess(accessLevel);
  if (typeof window === "undefined") return defaults;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Record<ColumnKey, boolean>>;
      const merged = { ...defaults, ...parsed };
      return merged;
    }
  } catch {
    // Ignore parse errors
  }
  return defaults;
}

export function getFilterStorageKey(catalogId: string): string {
  return `${FILTER_STORAGE_KEY_PREFIX}${catalogId}`;
}

export function loadStoredFilters(catalogId: string): StoredFilters | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(getFilterStorageKey(catalogId));
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function saveFiltersToStorage(catalogId: string, filters: StoredFilters): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getFilterStorageKey(catalogId), JSON.stringify(filters));
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

export function clearStoredFilters(catalogId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(getFilterStorageKey(catalogId));
  } catch {
    // Ignore storage errors
  }
}
