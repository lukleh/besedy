"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type {
  CatalogEntry,
  CatalogResponse,
  ColumnKey,
  StatusFilter,
  DurationFilter,
  VerifiedFilter,
  SortDirection,
  PaginationInfo,
} from "../types";
import { catalogResponseSchema } from "../types";
import { buildCatalogParams } from "../utils";
import { fetchJson } from "@/lib/api/fetch-json";

interface UseLoadMoreOptions {
  activeCatalogId: string | null | undefined;
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
  currentPage: number;
  currentEntries: CatalogEntry[];
  pagination: PaginationInfo | undefined;
  baseDataUpdatedAt?: number;
}

interface UseLoadMoreReturn {
  isLoadMoreMode: boolean;
  displayEntries: CatalogEntry[];
  loadedCount: number;
  isLoadingNext: boolean;
  isLoadingAll: boolean;
  loadNextPage: () => Promise<void>;
  loadAllPages: () => Promise<void>;
  reset: () => void;
  hasMoreToLoad: boolean;
  error: string | null;
}

export function useLoadMore(options: UseLoadMoreOptions): UseLoadMoreReturn {
  const {
    currentPage,
    currentEntries,
    pagination,
    baseDataUpdatedAt,
  } = options;

  // Accumulated entries state
  const [accumulatedEntries, setAccumulatedEntries] = useState<CatalogEntry[]>([]);
  const [highestLoadedPage, setHighestLoadedPage] = useState<number>(0);
  const [isLoadMoreMode, setIsLoadMoreMode] = useState(false);
  const [isLoadingNext, setIsLoadingNext] = useState(false);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Abort controller for cancelling in-flight requests
  const abortControllerRef = useRef<AbortController | null>(null);
  // Monotonic token used to discard late responses after filters/base data/page resets.
  const requestVersionRef = useRef(0);

  // Helper to create filter params object - used for both change detection and API calls
  const createFilterParams = useCallback(() => ({
    activeCatalogId: options.activeCatalogId,
    statusFilter: options.statusFilter,
    durationFilter: options.durationFilter,
    verifiedFilter: options.verifiedFilter,
    recorderFilter: options.recorderFilter,
    locationFilter: options.locationFilter,
    partFilter: options.partFilter,
    dateYear: options.dateYear,
    dateMonth: options.dateMonth,
    dateDay: options.dateDay,
    artistFilter: options.artistFilter,
    albumFilter: options.albumFilter,
    duplicatesFilter: options.duplicatesFilter,
    sortKey: options.sortKey,
    sortDir: options.sortDir,
  }), [
    options.activeCatalogId,
    options.statusFilter,
    options.durationFilter,
    options.verifiedFilter,
    options.recorderFilter,
    options.locationFilter,
    options.partFilter,
    options.dateYear,
    options.dateMonth,
    options.dateDay,
    options.artistFilter,
    options.albumFilter,
    options.duplicatesFilter,
    options.sortKey,
    options.sortDir,
  ]);

  // Track filter changes to reset accumulated state
  const filterKeyRef = useRef<string>("");
  const currentFilterKey = JSON.stringify(createFilterParams());

  const invalidatePendingRequest = useCallback((clearLoadingStates = true) => {
    requestVersionRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (clearLoadingStates) {
      setIsLoadingNext(false);
      setIsLoadingAll(false);
    }
  }, []);

  const resetLoadMoreState = useCallback(() => {
    setAccumulatedEntries([]);
    setHighestLoadedPage(0);
    setIsLoadMoreMode(false);
    setError(null);
  }, []);

  // Reset when filters change and abort any in-flight requests
  useEffect(() => {
    if (filterKeyRef.current !== currentFilterKey) {
      invalidatePendingRequest();
      filterKeyRef.current = currentFilterKey;
      resetLoadMoreState();
    }
  }, [currentFilterKey, invalidatePendingRequest, resetLoadMoreState]);

  // Track the base page when we started loading more
  const basePageRef = useRef<number>(currentPage);
  const hasLoadMoreActivity = isLoadMoreMode || isLoadingNext || isLoadingAll;

  // Reset when navigating via Previous/Next (currentPage changes from our base)
  useEffect(() => {
    if (hasLoadMoreActivity) {
      // If currentPage changed from our base page, user used Previous/Next
      if (currentPage !== basePageRef.current) {
        invalidatePendingRequest();
        resetLoadMoreState();
        basePageRef.current = currentPage;
      }
    } else {
      // Not in load more mode, just track the current page
      basePageRef.current = currentPage;
    }
  }, [currentPage, hasLoadMoreActivity, invalidatePendingRequest, resetLoadMoreState]);

  // Reset progressive state when the base catalog query refreshes with new page-1 data.
  // This keeps previously accumulated rows from outliving the source query data.
  const baseDataUpdatedAtRef = useRef<number | undefined>(baseDataUpdatedAt);
  useEffect(() => {
    if (!hasLoadMoreActivity) {
      baseDataUpdatedAtRef.current = baseDataUpdatedAt;
      return;
    }

    if (
      baseDataUpdatedAt !== undefined &&
      baseDataUpdatedAtRef.current !== undefined &&
      baseDataUpdatedAt !== baseDataUpdatedAtRef.current
    ) {
      invalidatePendingRequest();
      resetLoadMoreState();
      basePageRef.current = currentPage;
    }

    baseDataUpdatedAtRef.current = baseDataUpdatedAt;
  }, [
    baseDataUpdatedAt,
    currentPage,
    hasLoadMoreActivity,
    invalidatePendingRequest,
    resetLoadMoreState,
  ]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const reset = useCallback(() => {
    invalidatePendingRequest();
    resetLoadMoreState();
  }, [invalidatePendingRequest, resetLoadMoreState]);

  const loadNextPage = useCallback(async () => {
    if (!pagination || isLoadingNext || isLoadingAll) return;

    const nextPage = isLoadMoreMode ? highestLoadedPage + 1 : currentPage + 1;
    if (nextPage > pagination.totalPages) return;

    // Abort any existing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Capture current filter key to validate response
    const requestFilterKey = filterKeyRef.current;
    const requestVersion = requestVersionRef.current;

    setIsLoadingNext(true);
    setError(null);

    try {
      const params = buildCatalogParams(createFilterParams(), nextPage, 50);
      const data = await fetchJson<CatalogResponse>(`/api/catalog?${params.toString()}`, {
        signal: controller.signal,
        schema: catalogResponseSchema,
      });

      // Validate that filters haven't changed during the request
      if (
        filterKeyRef.current !== requestFilterKey ||
        requestVersionRef.current !== requestVersion ||
        abortControllerRef.current !== controller
      ) {
        return; // Filters changed, discard stale response
      }

      if (!isLoadMoreMode) {
        // First time loading more - initialize with current entries
        setAccumulatedEntries([...currentEntries, ...data.entries]);
        setHighestLoadedPage(nextPage);
        setIsLoadMoreMode(true);
      } else {
        // Append to existing accumulated entries
        setAccumulatedEntries((prev) => [...prev, ...data.entries]);
        setHighestLoadedPage(nextPage);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return; // Request was aborted, ignore
      }
      if (
        filterKeyRef.current !== requestFilterKey ||
        requestVersionRef.current !== requestVersion ||
        abortControllerRef.current !== controller
      ) {
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to load next page";
      setError(message);
    } finally {
      // Only clear loading state if this request is still the active one
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsLoadingNext(false);
      }
    }
  }, [
    pagination,
    isLoadingNext,
    isLoadingAll,
    isLoadMoreMode,
    highestLoadedPage,
    currentPage,
    currentEntries,
    createFilterParams,
  ]);

  const loadAllPages = useCallback(async () => {
    if (!pagination || isLoadingNext || isLoadingAll) return;
    if (pagination.totalPages <= 1) return;

    // Abort any existing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Capture current filter key to validate response
    const requestFilterKey = filterKeyRef.current;
    const requestVersion = requestVersionRef.current;

    setIsLoadingAll(true);
    setError(null);

    try {
      // Fetch all entries with limit=0
      const params = buildCatalogParams(createFilterParams(), 1, 0);
      const data = await fetchJson<CatalogResponse>(`/api/catalog?${params.toString()}`, {
        signal: controller.signal,
        schema: catalogResponseSchema,
      });

      // Validate that filters haven't changed during the request
      if (
        filterKeyRef.current !== requestFilterKey ||
        requestVersionRef.current !== requestVersion ||
        abortControllerRef.current !== controller
      ) {
        return; // Filters changed, discard stale response
      }

      setAccumulatedEntries(data.entries);
      setHighestLoadedPage(pagination.totalPages);
      setIsLoadMoreMode(true);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return; // Request was aborted, ignore
      }
      if (
        filterKeyRef.current !== requestFilterKey ||
        requestVersionRef.current !== requestVersion ||
        abortControllerRef.current !== controller
      ) {
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to load all pages";
      setError(message);
    } finally {
      // Only clear loading state if this request is still the active one
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsLoadingAll(false);
      }
    }
  }, [pagination, isLoadingNext, isLoadingAll, createFilterParams]);

  // Determine if there's more to load
  const hasMoreToLoad = pagination
    ? isLoadMoreMode
      ? highestLoadedPage < pagination.totalPages
      : pagination.hasNextPage
    : false;

  // Determine which entries to display
  const displayEntries = isLoadMoreMode ? accumulatedEntries : currentEntries;
  const loadedCount = isLoadMoreMode ? accumulatedEntries.length : currentEntries.length;

  return {
    isLoadMoreMode,
    displayEntries,
    loadedCount,
    isLoadingNext,
    isLoadingAll,
    loadNextPage,
    loadAllPages,
    reset,
    hasMoreToLoad,
    error,
  };
}
