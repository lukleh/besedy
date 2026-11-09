"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { FilterOptionsResponse } from "@/hooks/use-filter-options";
import type { ColumnKey } from "../types";
import {
  loadStoredFilters,
  saveFiltersToStorage,
  clearStoredFilters,
} from "../constants";
import {
  DEFAULT_FILTERS,
  DEFAULT_FILTER_STATE,
  FILTER_KEYS,
  restoreCatalogFilters,
  type CatalogFilterKey,
  type CatalogFilterState,
} from "../filter-state";

interface UseCatalogFiltersOptions {
  catalogId: string | null | undefined;
  activeCatalogId: string | null | undefined;
  isHydrated: boolean;
}

export type UseCatalogFiltersReturn = ReturnType<typeof useCatalogFilters>;

export function useCatalogFilters({
  catalogId,
  activeCatalogId,
  isHydrated,
}: UseCatalogFiltersOptions) {
  const [values, setValues] = useState(DEFAULT_FILTER_STATE);
  const [filtersReady, setFiltersReady] = useState(false);
  const filtersLoadedRef = useRef(false);

  // Hydrate once before allowing list requests or persisting defaults.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isHydrated || filtersLoadedRef.current) return;
    filtersLoadedRef.current = true;
    if (catalogId)
      setValues(restoreCatalogFilters(loadStoredFilters(catalogId)));
    setFiltersReady(true);
  }, [isHydrated, catalogId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!activeCatalogId || !filtersReady) return;
    const stored = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          value !== DEFAULT_FILTER_STATE[key as keyof CatalogFilterState],
      ),
    );
    if (Object.keys(stored).length)
      saveFiltersToStorage(activeCatalogId, stored);
    else clearStoredFilters(activeCatalogId);
  }, [activeCatalogId, filtersReady, values]);

  const updateFilters = useCallback((patch: Partial<CatalogFilterState>) => {
    setValues((previous) => ({ ...previous, ...patch, page: 1 }));
  }, []);

  // Stable control callbacks also allow URL filters to apply exactly once.
  const setters = useMemo(() => {
    const setter =
      <K extends CatalogFilterKey>(key: K) =>
      (value: CatalogFilterState[K]) =>
        updateFilters({ [key]: value });
    return {
      setStatusFilter: setter("status"),
      setDurationFilter: setter("duration"),
      setVerifiedFilter: setter("verified"),
      setRecorderFilter: setter("recorder"),
      setLocationFilter: setter("location"),
      setPartFilter: setter("part"),
      setArtistFilter: setter("artist"),
      setAlbumFilter: setter("album"),
      setDuplicatesFilter: setter("duplicates"),
      setDateYear: setter("dateYear"),
      setDateMonth: setter("dateMonth"),
      setDateDay: setter("dateDay"),
    };
  }, [updateFilters]);

  const handleDateYearChange = (value: string) =>
    updateFilters({
      dateYear: value,
      ...(value === "all" || value === "empty"
        ? { dateMonth: "all", dateDay: "all" }
        : {}),
    });
  const handleDateMonthChange = (value: string) =>
    updateFilters({ dateMonth: value, dateDay: "all" });
  const handleSort = (key: ColumnKey) =>
    setValues((previous) => ({
      ...previous,
      sortKey:
        previous.sortKey === key && previous.sortDir === "asc" ? "date" : key,
      sortDir:
        previous.sortKey === key && previous.sortDir === "desc"
          ? "asc"
          : "desc",
      page: 1,
    }));
  const handlePageChange = (page: number) => {
    setValues((previous) => ({ ...previous, page }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const clearFilters = () => updateFilters(DEFAULT_FILTERS);
  const clearFilterForColumn = (key: ColumnKey) => {
    if (key === "date")
      updateFilters({ dateYear: "all", dateMonth: "all", dateDay: "all" });
    else if (key in DEFAULT_FILTERS) updateFilters({ [key]: "all" });
  };
  const resetPageIfInvalid = useCallback((totalPages: number) => {
    setValues((previous) =>
      totalPages > 0 && previous.page > totalPages
        ? { ...previous, page: 1 }
        : previous,
    );
  }, []);

  const syncWithAvailableOptions = useCallback(
    (
      filterOptions: FilterOptionsResponse | undefined,
      skipInvalid: Partial<Record<ColumnKey, boolean>> = {},
    ) => {
      if (!filterOptions) return;
      setValues((previous) => {
        const next = { ...previous };
        const { options } = filterOptions;
        const validValues: Record<CatalogFilterKey, string[]> = {
          recorder: (options.recorders ?? []).map((value) => String(value.id)),
          location: (options.locations ?? []).map((value) => String(value.id)),
          album: (options.albums ?? []).map((value) => String(value.id)),
          part: (options.parts ?? []).map((value) => String(value.value)),
          artist: (options.artists ?? []).map((value) => value.value),
          duplicates: (options.duplicates ?? []).map((value) =>
            String(value.value),
          ),
          dateYear: (options.years ?? []).map((value) => String(value.value)),
          dateMonth: (options.months ?? []).map((value) => String(value.value)),
          dateDay: (options.days ?? []).map((value) => String(value.value)),
          status: (options.statuses ?? []).map((value) => value.value),
          duration: (options.durations ?? []).map((value) => value.value),
          verified: (options.verified ?? []).map((value) =>
            value.value ? "verified" : "unverified",
          ),
        };
        for (const key of FILTER_KEYS) {
          const value = next[key];
          if (value === "all") continue;
          if (
            (key === "recorder" || key === "location" || key === "album") &&
            skipInvalid[key]
          )
            continue;
          // Null metadata is a valid selection even when no matching facet is returned.
          if (
            value === "empty" &&
            [
              "recorder",
              "location",
              "album",
              "part",
              "artist",
              "dateYear",
            ].includes(key)
          )
            continue;
          if (
            (key === "dateMonth" || key === "dateDay") &&
            (next.dateYear === "all" || next.dateYear === "empty")
          )
            continue;
          if (key === "dateDay" && next.dateMonth === "all") continue;
          if (validValues[key].includes(value)) continue;
          Object.assign(next, { [key]: "all" });
          if (key === "dateYear") next.dateMonth = next.dateDay = "all";
          if (key === "dateMonth") next.dateDay = "all";
        }
        return FILTER_KEYS.some((key) => next[key] !== previous[key])
          ? next
          : previous;
      });
    },
    [],
  );

  return {
    values,
    statusFilter: values.status,
    durationFilter: values.duration,
    verifiedFilter: values.verified,
    recorderFilter: values.recorder,
    locationFilter: values.location,
    partFilter: values.part,
    artistFilter: values.artist,
    albumFilter: values.album,
    duplicatesFilter: values.duplicates,
    dateYear: values.dateYear,
    dateMonth: values.dateMonth,
    dateDay: values.dateDay,
    sortKey: values.sortKey,
    sortDir: values.sortDir,
    page: values.page,
    ...setters,
    handleDateYearChange,
    handleDateMonthChange,
    handleSort,
    handlePageChange,
    clearFilters,
    clearFilterForColumn,
    resetPageIfInvalid,
    hasActiveFilters: FILTER_KEYS.some((key) => values[key] !== "all"),
    filtersReady,
    syncWithAvailableOptions,
  };
}
