import type {
  EventListQueryState,
  StoredEventListState,
} from "./event-list-types";

const EVENT_FILTER_STORAGE_KEY_PREFIX = "besedy-event-filters-";

function getEventStorageKey(catalogId: string): string {
  return `${EVENT_FILTER_STORAGE_KEY_PREFIX}${catalogId}`;
}

export function loadStoredEventListState(
  catalogId: string,
): StoredEventListState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(getEventStorageKey(catalogId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredEventListState;
  } catch {
    return null;
  }
}

export function saveEventListState(
  catalogId: string,
  state: StoredEventListState,
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getEventStorageKey(catalogId), JSON.stringify(state));
  } catch {
    // Ignore localStorage write errors.
  }
}

export function clearStoredEventListState(catalogId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(getEventStorageKey(catalogId));
  } catch {
    // Ignore localStorage delete errors.
  }
}

export function buildEventListParams(
  catalogId: string,
  page: number,
  limit: number,
  state: EventListQueryState,
): URLSearchParams {
  const params = new URLSearchParams({
    group: catalogId,
    page: String(page),
    limit: String(limit),
    sort: state.sortKey,
    dir: state.sortDir,
  });

  if (state.releasedFilter !== "all")
    params.set("released", state.releasedFilter);
  if (state.locationFilter !== "all")
    params.set("location", state.locationFilter);
  if (state.dateYearFilter !== "all")
    params.set("dateYear", state.dateYearFilter);

  return params;
}
