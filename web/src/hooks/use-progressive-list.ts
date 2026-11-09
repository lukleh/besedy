"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ProgressiveListOptions<T> {
  requestKey: string;
  currentPage: number;
  currentEntries: T[];
  pagination: { totalPages: number; hasNextPage: boolean } | undefined;
  baseDataUpdatedAt?: number;
  fetchPage: (page: number, limit: number, signal: AbortSignal) => Promise<T[]>;
  nextError?: string;
  allError?: string;
}

interface ProgressiveState<T> {
  entries: T[] | null;
  highestPage: number;
  loading: "next" | "all" | null;
  error: string | null;
}

/** Owns the shared next/all request lifecycle; adapters own URLs and response shapes. */
export function useProgressiveList<T>({
  requestKey,
  currentPage,
  currentEntries,
  pagination,
  baseDataUpdatedAt,
  fetchPage,
  nextError = "Failed to load next page",
  allError = "Failed to load all pages",
}: ProgressiveListOptions<T>) {
  const [state, setState] = useState<ProgressiveState<T>>({
    entries: null,
    highestPage: 0,
    loading: null,
    error: null,
  });
  const activeRequest = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);

  const reset = useCallback(() => {
    requestVersion.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setState((previous) =>
      previous.entries === null && !previous.loading && !previous.error
        ? previous
        : { entries: null, highestPage: 0, loading: null, error: null },
    );
  }, []);

  // Query changes and refreshes invalidate rows accumulated from the previous response.
  useEffect(() => {
    reset();
  }, [requestKey, currentPage, baseDataUpdatedAt, reset]);

  useEffect(
    () => () => {
      requestVersion.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    },
    [],
  );

  const load = useCallback(
    async (mode: "next" | "all") => {
      if (!pagination || activeRequest.current) return;
      const page =
        mode === "all"
          ? 1
          : (state.entries ? state.highestPage : currentPage) + 1;
      if (
        mode === "all"
          ? pagination.totalPages <= 1
          : page > pagination.totalPages
      )
        return;

      const controller = new AbortController();
      activeRequest.current = controller;
      const version = requestVersion.current;
      const isCurrent = () =>
        activeRequest.current === controller &&
        requestVersion.current === version;
      setState((previous) => ({ ...previous, loading: mode, error: null }));
      try {
        const entries = await fetchPage(
          page,
          mode === "all" ? 0 : 50,
          controller.signal,
        );
        if (!isCurrent()) return;
        setState((previous) => ({
          entries:
            mode === "all"
              ? entries
              : [...(previous.entries ?? currentEntries), ...entries],
          highestPage: mode === "all" ? pagination.totalPages : page,
          loading: null,
          error: null,
        }));
      } catch (error) {
        if (
          !isCurrent() ||
          (error instanceof Error && error.name === "AbortError")
        )
          return;
        setState((previous) => ({
          ...previous,
          error:
            error instanceof Error
              ? error.message
              : mode === "all"
                ? allError
                : nextError,
        }));
      } finally {
        if (isCurrent()) {
          activeRequest.current = null;
          setState((previous) =>
            previous.loading ? { ...previous, loading: null } : previous,
          );
        }
      }
    },
    [
      pagination,
      currentPage,
      currentEntries,
      state.entries,
      state.highestPage,
      fetchPage,
      nextError,
      allError,
    ],
  );

  const displayEntries = state.entries ?? currentEntries;
  return {
    isLoadMoreMode: state.entries !== null,
    displayEntries,
    loadedCount: displayEntries.length,
    isLoadingNext: state.loading === "next",
    isLoadingAll: state.loading === "all",
    loadNextPage: useCallback(() => load("next"), [load]),
    loadAllPages: useCallback(() => load("all"), [load]),
    reset,
    hasMoreToLoad: pagination
      ? state.entries !== null
        ? state.highestPage < pagination.totalPages
        : pagination.hasNextPage
      : false,
    error: state.error,
  };
}
