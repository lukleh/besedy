"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { FilterOptionsResponse } from "@/hooks/use-filter-options";
import type {
  ColumnKey,
  StatusFilter,
  DurationFilter,
  VerifiedFilter,
  SortDirection,
} from "../types";
import {
  DEFAULT_SORT,
  isColumnKey,
  loadStoredFilters,
  saveFiltersToStorage,
  clearStoredFilters,
} from "../constants";

interface UseCatalogFiltersOptions {
  catalogId: string | null | undefined;
  activeCatalogId: string | null | undefined;
  isHydrated: boolean;
  columnVisibility: Record<ColumnKey, boolean>;
}

export interface UseCatalogFiltersReturn {
  // Filter values
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
  page: number;

  // Setters
  setStatusFilter: (v: StatusFilter) => void;
  setDurationFilter: (v: DurationFilter) => void;
  setVerifiedFilter: (v: VerifiedFilter) => void;
  setRecorderFilter: (v: string) => void;
  setLocationFilter: (v: string) => void;
  setPartFilter: (v: string) => void;
  setDateYear: (v: string) => void;
  setDateMonth: (v: string) => void;
  setDateDay: (v: string) => void;
  setArtistFilter: (v: string) => void;
  setAlbumFilter: (v: string) => void;
  setDuplicatesFilter: (v: string) => void;

  // Handlers
  handleDateYearChange: (value: string) => void;
  handleDateMonthChange: (value: string) => void;
  handleSort: (key: ColumnKey) => void;
  handlePageChange: (newPage: number) => void;
  clearFilters: () => void;
  clearFilterForColumn: (key: ColumnKey) => void;
  resetPageIfInvalid: (totalPages: number) => void;

  // Computed
  hasActiveFilters: boolean;
  filtersReady: boolean;

  // For auto-clearing invalid selections
  syncWithAvailableOptions: (
    options: FilterOptionsResponse | undefined,
    skipInvalid?: Partial<Record<ColumnKey, boolean>>
  ) => void;
}

export function useCatalogFilters({
  catalogId,
  activeCatalogId,
  isHydrated,
  columnVisibility,
}: UseCatalogFiltersOptions): UseCatalogFiltersReturn {
  // Initialize all filter state with defaults
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("all");
  const [verifiedFilter, setVerifiedFilter] = useState<VerifiedFilter>("all");
  const [recorderFilter, setRecorderFilter] = useState<string>("all");
  const [locationFilter, setLocationFilter] = useState<string>("all");
  const [partFilter, setPartFilter] = useState<string>("all");
  const [dateYear, setDateYear] = useState("all");
  const [dateMonth, setDateMonth] = useState("all");
  const [dateDay, setDateDay] = useState("all");
  const [artistFilter, setArtistFilter] = useState<string>("all");
  const [albumFilter, setAlbumFilter] = useState<string>("all");
  const [duplicatesFilter, setDuplicatesFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<ColumnKey>(DEFAULT_SORT.key);
  const [sortDir, setSortDir] = useState<SortDirection>(DEFAULT_SORT.dir);
  const [page, setPage] = useState(1);

  // Track when filters are ready (after hydration + localStorage load attempt)
  const [filtersReady, setFiltersReady] = useState(false);
  const filtersLoadedRef = useRef(false);

  // Load filters from localStorage after hydration
  // Intentional: hydration from localStorage runs once on mount
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isHydrated || filtersLoadedRef.current) return;
    filtersLoadedRef.current = true;

    if (catalogId) {
      const storedFilters = loadStoredFilters(catalogId);
      if (storedFilters) {
        if (storedFilters.status === "ready" || storedFilters.status === "incomplete") {
          setStatusFilter(storedFilters.status);
        }
        if (storedFilters.duration === "short" || storedFilters.duration === "medium" || storedFilters.duration === "long") {
          setDurationFilter(storedFilters.duration);
        }
        if (storedFilters.verified === "verified" || storedFilters.verified === "unverified") {
          setVerifiedFilter(storedFilters.verified);
        }
        if (storedFilters.recorder) setRecorderFilter(storedFilters.recorder);
        if (storedFilters.location) setLocationFilter(storedFilters.location);
        if (storedFilters.part) setPartFilter(storedFilters.part);
        if (storedFilters.dateYear) setDateYear(storedFilters.dateYear);
        if (storedFilters.dateMonth) setDateMonth(storedFilters.dateMonth);
        if (storedFilters.dateDay) setDateDay(storedFilters.dateDay);
        if (storedFilters.artist) setArtistFilter(storedFilters.artist);
        if (storedFilters.album) setAlbumFilter(storedFilters.album);
        if (storedFilters.duplicates) setDuplicatesFilter(storedFilters.duplicates);
        // Restore sort state from localStorage
        if (isColumnKey(storedFilters.sortKey)) setSortKey(storedFilters.sortKey);
        if (storedFilters.sortDir === "asc" || storedFilters.sortDir === "desc") {
          setSortDir(storedFilters.sortDir);
        }
        if (typeof storedFilters.page === "number" && storedFilters.page > 0) {
          setPage(storedFilters.page);
        }
      }
    }
    // Mark filters as ready after load attempt completes
    setFiltersReady(true);
  }, [isHydrated, catalogId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Sync filters to localStorage whenever they change
  useEffect(() => {
    if (!activeCatalogId || !filtersReady) return;

    const filters = {
      status: statusFilter !== "all" ? statusFilter : undefined,
      duration: durationFilter !== "all" ? durationFilter : undefined,
      verified: verifiedFilter !== "all" ? verifiedFilter : undefined,
      recorder: recorderFilter !== "all" ? recorderFilter : undefined,
      location: locationFilter !== "all" ? locationFilter : undefined,
      part: partFilter !== "all" ? partFilter : undefined,
      dateYear: dateYear !== "all" ? dateYear : undefined,
      dateMonth: dateMonth !== "all" ? dateMonth : undefined,
      dateDay: dateDay !== "all" ? dateDay : undefined,
      artist: artistFilter !== "all" ? artistFilter : undefined,
      album: albumFilter !== "all" ? albumFilter : undefined,
      duplicates: duplicatesFilter !== "all" ? duplicatesFilter : undefined,
      sortKey: sortKey !== DEFAULT_SORT.key ? sortKey : undefined,
      sortDir: sortDir !== DEFAULT_SORT.dir ? sortDir : undefined,
      page: page > 1 ? page : undefined,
    };

    const hasValues = Object.values(filters).some(v => v !== undefined);
    if (hasValues) {
      saveFiltersToStorage(activeCatalogId, filters);
    } else {
      clearStoredFilters(activeCatalogId);
    }
  }, [
    filtersReady, activeCatalogId, statusFilter, durationFilter, verifiedFilter,
    recorderFilter, locationFilter, partFilter, dateYear, dateMonth, dateDay,
    artistFilter, albumFilter, duplicatesFilter, sortKey, sortDir, page,
  ]);

  // Handlers
  // Note: These handlers use raw setters (not the page-resetting wrappers) because they
  // explicitly manage page reset themselves, along with cascading field resets for dates.
  const handleDateYearChange = (value: string) => {
    setDateYear(value);
    // Reset month/day when year is "all" or "empty" (no point in month filter without a year)
    if (value === "all" || value === "empty") {
      setDateMonth("all");
      setDateDay("all");
    }
    setPage(1);
  };

  const handleDateMonthChange = (value: string) => {
    setDateMonth(value);
    setDateDay("all");
    setPage(1);
  };

  const handleSort = (key: ColumnKey) => {
    if (sortKey === key) {
      if (sortDir === "desc") {
        setSortDir("asc");
      } else {
        setSortKey("date");
        setSortDir("desc");
      }
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearFilters = () => {
    setStatusFilter("all");
    setDurationFilter("all");
    setVerifiedFilter("all");
    setRecorderFilter("all");
    setLocationFilter("all");
    setPartFilter("all");
    setDateYear("all");
    setDateMonth("all");
    setDateDay("all");
    setArtistFilter("all");
    setAlbumFilter("all");
    setDuplicatesFilter("all");
    setPage(1);
    if (activeCatalogId) {
      clearStoredFilters(activeCatalogId);
    }
  };

  const clearFilterForColumn = (key: ColumnKey) => {
    switch (key) {
      case "status": setStatusFilter("all"); break;
      case "duration": setDurationFilter("all"); break;
      case "verified": setVerifiedFilter("all"); break;
      case "recorder": setRecorderFilter("all"); break;
      case "location": setLocationFilter("all"); break;
      case "part": setPartFilter("all"); break;
      case "date": setDateYear("all"); setDateMonth("all"); setDateDay("all"); break;
      case "artist": setArtistFilter("all"); break;
      case "album": setAlbumFilter("all"); break;
      case "duplicates": setDuplicatesFilter("all"); break;
    }
    setPage(1);
  };

  // Reset page to 1 if current page exceeds available pages
  // This handles the case where stored page is stale (e.g., data changed while user was away)
  const resetPageIfInvalid = useCallback((totalPages: number) => {
    if (totalPages > 0 && page > totalPages) {
      setPage(1);
    }
  }, [page]);

  // Auto-clear invalid filter selections when options change
  const syncWithAvailableOptions = useCallback((
    filterOptions: FilterOptionsResponse | undefined,
    skipInvalid: Partial<Record<ColumnKey, boolean>> = {}
  ) => {
    if (!filterOptions) return;

    const { options } = filterOptions;
    const recorders = options.recorders ?? [];
    const locations = options.locations ?? [];
    const artists = options.artists ?? [];
    const albums = options.albums ?? [];
    const duplicateCounts = options.duplicates ?? [];
    const availableParts = options.parts ?? [];
    const availableYears = options.years ?? [];
    const availableMonths = options.months ?? [];
    const availableDays = options.days ?? [];
    const availableStatuses = options.statuses ?? [];
    const availableDurations = options.durations ?? [];
    const availableVerified = options.verified ?? [];

    // Check recorder filter ("empty" is always valid - filters for null values)
    if (!skipInvalid.recorder && recorderFilter !== "all" && recorderFilter !== "empty") {
      const validIds = new Set(recorders.map((r) => r.id.toString()));
      if (!validIds.has(recorderFilter)) {
        setRecorderFilter("all");
      }
    }

    // Check location filter ("empty" is always valid - filters for null values)
    if (!skipInvalid.location && locationFilter !== "all" && locationFilter !== "empty") {
      const validIds = new Set(locations.map((l) => l.id.toString()));
      if (!validIds.has(locationFilter)) {
        setLocationFilter("all");
      }
    }

    // Check part filter ("empty" is always valid - filters for null values)
    if (partFilter !== "all" && partFilter !== "empty") {
      const validValues = new Set(availableParts.map((p) => p.value.toString()));
      if (!validValues.has(partFilter)) {
        setPartFilter("all");
      }
    }

    // Check artist filter ("empty" is always valid - filters for null values)
    if (artistFilter !== "all" && artistFilter !== "empty") {
      const validValues = new Set(artists.map((a) => a.value));
      if (!validValues.has(artistFilter)) {
        setArtistFilter("all");
      }
    }

    // Check album filter ("empty" is always valid - filters for null values)
    if (!skipInvalid.album && albumFilter !== "all" && albumFilter !== "empty") {
      const validIds = new Set(albums.map((a) => a.id.toString()));
      if (!validIds.has(albumFilter)) {
        setAlbumFilter("all");
      }
    }

    // Check duplicates filter
    if (duplicatesFilter !== "all") {
      const validValues = new Set(duplicateCounts.map((d) => d.value.toString()));
      if (!validValues.has(duplicatesFilter)) {
        setDuplicatesFilter("all");
      }
    }

    // Check date filters (cascading) - "empty" is valid for year (filters for no date)
    if (dateYear !== "all" && dateYear !== "empty") {
      const validYears = new Set(availableYears.map((y) => y.value.toString()));
      if (!validYears.has(dateYear)) {
        setDateYear("all");
        setDateMonth("all");
        setDateDay("all");
      } else if (dateMonth !== "all") {
        const validMonths = new Set(availableMonths.map((m) => m.value.toString()));
        if (!validMonths.has(dateMonth)) {
          setDateMonth("all");
          setDateDay("all");
        } else if (dateDay !== "all") {
          const validDays = new Set(availableDays.map((d) => d.value.toString()));
          if (!validDays.has(dateDay)) {
            setDateDay("all");
          }
        }
      }
    }

    // Check status filter
    if (statusFilter !== "all") {
      const validValues = new Set(availableStatuses.map((s) => s.value));
      if (!validValues.has(statusFilter)) {
        setStatusFilter("all");
      }
    }

    // Check duration filter
    if (durationFilter !== "all") {
      const validValues = new Set(availableDurations.map((d) => d.value));
      if (!validValues.has(durationFilter)) {
        setDurationFilter("all");
      }
    }

    // Check verified filter
    if (verifiedFilter !== "all") {
      const validValues = new Set(
        availableVerified.map((v) => v.value ? "verified" : "unverified")
      );
      if (!validValues.has(verifiedFilter)) {
        setVerifiedFilter("all");
      }
    }
  }, [
    recorderFilter, locationFilter, partFilter, artistFilter, albumFilter,
    duplicatesFilter, dateYear, dateMonth, dateDay, statusFilter, durationFilter, verifiedFilter,
  ]);

  const hasActiveFilters =
    (columnVisibility.status && statusFilter !== "all") ||
    (columnVisibility.duration && durationFilter !== "all") ||
    (columnVisibility.verified && verifiedFilter !== "all") ||
    (columnVisibility.recorder && recorderFilter !== "all") ||
    (columnVisibility.location && locationFilter !== "all") ||
    (columnVisibility.part && partFilter !== "all") ||
    (columnVisibility.date &&
      (dateYear !== "all" || dateMonth !== "all" || dateDay !== "all")) ||
    (columnVisibility.artist && artistFilter !== "all") ||
    (columnVisibility.album && albumFilter !== "all") ||
    (columnVisibility.duplicates && duplicatesFilter !== "all");

  // Wrapped setters that reset page to 1 on filter change
  // Note: useState setters are stable, so empty deps array is safe
  const setStatusFilterWrapped = useCallback((v: StatusFilter) => { setStatusFilter(v); setPage(1); }, []);
  const setDurationFilterWrapped = useCallback((v: DurationFilter) => { setDurationFilter(v); setPage(1); }, []);
  const setVerifiedFilterWrapped = useCallback((v: VerifiedFilter) => { setVerifiedFilter(v); setPage(1); }, []);
  const setRecorderFilterWrapped = useCallback((v: string) => { setRecorderFilter(v); setPage(1); }, []);
  const setLocationFilterWrapped = useCallback((v: string) => { setLocationFilter(v); setPage(1); }, []);
  const setPartFilterWrapped = useCallback((v: string) => { setPartFilter(v); setPage(1); }, []);
  const setDateYearWrapped = useCallback((v: string) => { setDateYear(v); setPage(1); }, []);
  const setDateMonthWrapped = useCallback((v: string) => { setDateMonth(v); setPage(1); }, []);
  const setDateDayWrapped = useCallback((v: string) => { setDateDay(v); setPage(1); }, []);
  const setArtistFilterWrapped = useCallback((v: string) => { setArtistFilter(v); setPage(1); }, []);
  const setAlbumFilterWrapped = useCallback((v: string) => { setAlbumFilter(v); setPage(1); }, []);
  const setDuplicatesFilterWrapped = useCallback((v: string) => { setDuplicatesFilter(v); setPage(1); }, []);

  return {
    // Filter values
    statusFilter,
    durationFilter,
    verifiedFilter,
    recorderFilter,
    locationFilter,
    partFilter,
    dateYear,
    dateMonth,
    dateDay,
    artistFilter,
    albumFilter,
    duplicatesFilter,
    sortKey,
    sortDir,
    page,

    // Setters (with automatic page reset)
    setStatusFilter: setStatusFilterWrapped,
    setDurationFilter: setDurationFilterWrapped,
    setVerifiedFilter: setVerifiedFilterWrapped,
    setRecorderFilter: setRecorderFilterWrapped,
    setLocationFilter: setLocationFilterWrapped,
    setPartFilter: setPartFilterWrapped,
    setDateYear: setDateYearWrapped,
    setDateMonth: setDateMonthWrapped,
    setDateDay: setDateDayWrapped,
    setArtistFilter: setArtistFilterWrapped,
    setAlbumFilter: setAlbumFilterWrapped,
    setDuplicatesFilter: setDuplicatesFilterWrapped,

    // Handlers
    handleDateYearChange,
    handleDateMonthChange,
    handleSort,
    handlePageChange,
    clearFilters,
    clearFilterForColumn,
    resetPageIfInvalid,

    // Computed
    hasActiveFilters,
    filtersReady,

    // For auto-clearing invalid selections
    syncWithAvailableOptions,
  };
}
