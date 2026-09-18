"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { AuditLog, AuditLogGroup, LoadMorePagination } from "../types";
import { groupLogsByKey } from "../utils";
import { fetchJson } from "@/lib/api/fetch-json";

interface UseAuditLoadMoreOptions {
  actionFilter: string;
  resourceFilter: string;
  userFilter: string;
  domainFilter: string;
  subjectTypeFilter: string;
  outcomeFilter: string;
  dateFrom: string;
  dateTo: string;
}

export interface AuditFilterOptions {
  domains: string[];
  subjectTypes: string[];
  outcomes: string[];
}

export interface LoadingProgress {
  loadedEntries: number;
  totalEntries: number;
  groupsFormed: number;
  targetGroups: number;
  batchesFetched: number;
}

interface UseAuditLoadMoreReturn {
  groups: AuditLogGroup[];
  pagination: LoadMorePagination;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadingProgress: LoadingProgress | null;
  error: string | null;
  resources: string[];
  filters: AuditFilterOptions;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  expandedGroups: Set<string>;
  toggleGroup: (groupKey: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

const BATCH_SIZE = 150;
const TARGET_GROUPS = 50;

export function useAuditLoadMore(
  options: UseAuditLoadMoreOptions
): UseAuditLoadMoreReturn {
  // Raw logs accumulated from all batches
  const [logs, setLogs] = useState<AuditLog[]>([]);
  // Grouped view derived from logs
  const [groups, setGroups] = useState<AuditLogGroup[]>([]);
  const [resources, setResources] = useState<string[]>([]);
  const [filters, setFilters] = useState<AuditFilterOptions>({
    domains: [],
    subjectTypes: [],
    outcomes: [],
  });
  const [pagination, setPagination] = useState<LoadMorePagination>({
    hasMore: true,
    totalCount: 0,
    loadedCount: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Expansion state - tracks which groups are expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Abort controller for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track filter changes
  const currentFilterKey = JSON.stringify(options);
  const prevFilterKeyRef = useRef<string>(currentFilterKey);
  const hasMountedRef = useRef(false);

  // Build URL params for fetch
  const buildParams = useCallback(
    (offset: number) => {
      const params = new URLSearchParams();
      params.set("offset", String(offset));
      params.set("limit", String(BATCH_SIZE));
      if (options.actionFilter) params.set("action", options.actionFilter);
      if (options.resourceFilter)
        params.set("resource", options.resourceFilter);
      if (options.userFilter) params.set("userId", options.userFilter);
      if (options.domainFilter) params.set("domain", options.domainFilter);
      if (options.subjectTypeFilter) {
        params.set("subjectType", options.subjectTypeFilter);
      }
      if (options.outcomeFilter) params.set("outcome", options.outcomeFilter);
      if (options.dateFrom) params.set("from", options.dateFrom);
      if (options.dateTo) params.set("to", options.dateTo);
      return params;
    },
    [options]
  );

  // Fetch a single batch - returns the data without updating state
  const fetchBatch = useCallback(
    async (
      offset: number,
      signal: AbortSignal
    ): Promise<{
      logs: AuditLog[];
      resources: string[];
      filters: AuditFilterOptions;
      total: number;
      hasMore: boolean;
    }> => {
      const params = buildParams(offset);
      const data = await fetchJson<{
        logs: AuditLog[];
        resources?: string[];
        filters?: Partial<AuditFilterOptions>;
        pagination: { total: number };
      }>(`/api/admin/audit?${params.toString()}`, { signal });
      return {
        logs: data.logs,
        resources: data.resources || [],
        filters: {
          domains: data.filters?.domains || [],
          subjectTypes: data.filters?.subjectTypes || [],
          outcomes: data.filters?.outcomes || [],
        },
        total: data.pagination.total,
        hasMore: data.logs.length === BATCH_SIZE,
      };
    },
    [buildParams]
  );

  // Load until we have enough groups (no flickering - updates state only once at the end)
  const loadUntilFull = useCallback(
    async (
      existingLogs: AuditLog[],
      existingGroupCount: number,
      isAppend: boolean
    ) => {
      // Abort previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const requestFilterKey = JSON.stringify(options);

      if (isAppend) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        let accumulatedLogs = [...existingLogs];
        let fetchedResources: string[] = [];
        let fetchedFilters: AuditFilterOptions = {
          domains: [],
          subjectTypes: [],
          outcomes: [],
        };
        let totalCount = 0;
        let hasMore = true;
        let batchesFetched = 0;
        const targetGroups = isAppend
          ? existingGroupCount + TARGET_GROUPS
          : TARGET_GROUPS;

        // Initialize progress
        setLoadingProgress({
          loadedEntries: accumulatedLogs.length,
          totalEntries: 0,
          groupsFormed: existingGroupCount,
          targetGroups,
          batchesFetched: 0,
        });

        // Keep fetching until we have enough groups or no more data
        while (hasMore) {
          // Check if aborted
          if (controller.signal.aborted) {
            return;
          }

          const batch = await fetchBatch(accumulatedLogs.length, controller.signal);
          batchesFetched++;

          // Check if filters changed during request
          if (JSON.stringify(options) !== requestFilterKey) {
            return; // Discard stale response
          }

          accumulatedLogs = [...accumulatedLogs, ...batch.logs];
          if (!isAppend && batch.resources.length > 0) {
            fetchedResources = batch.resources;
          }
          if (!isAppend) {
            fetchedFilters = batch.filters;
          }
          totalCount = batch.total;
          hasMore = batch.hasMore;

          // Check if we have enough groups
          const currentGroups = groupLogsByKey(accumulatedLogs);

          // Update progress (this will show during loading)
          setLoadingProgress({
            loadedEntries: accumulatedLogs.length,
            totalEntries: totalCount,
            groupsFormed: currentGroups.length,
            targetGroups,
            batchesFetched,
          });

          if (currentGroups.length >= targetGroups || !hasMore) {
            // We have enough groups or no more data - update state once
            if (!isAppend) {
              setResources(fetchedResources);
              setFilters(fetchedFilters);
              setExpandedGroups(new Set());
            }
            setLogs(accumulatedLogs);
            setGroups(currentGroups);
            setPagination({
              hasMore,
              totalCount,
              loadedCount: accumulatedLogs.length,
            });
            break;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        if (abortControllerRef.current === controller) {
          setIsLoading(false);
          setIsLoadingMore(false);
          setLoadingProgress(null);
        }
      }
    },
    [options, fetchBatch]
  );

  // Load data when filter changes OR when we have no data yet
  useEffect(() => {
    const filterChanged = prevFilterKeyRef.current !== currentFilterKey;
    const needsInitialLoad = !hasMountedRef.current;

    if (needsInitialLoad || filterChanged) {
      hasMountedRef.current = true;
      prevFilterKeyRef.current = currentFilterKey;
      loadUntilFull([], 0, false);
    }
  }, [currentFilterKey, loadUntilFull]);

  // Cleanup on unmount - reset mounted flag and abort requests
  useEffect(() => {
    return () => {
      hasMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Load more handler - loads until we add TARGET_GROUPS more groups
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !pagination.hasMore) return;
    await loadUntilFull(logs, groups.length, true);
  }, [isLoadingMore, pagination.hasMore, logs, groups.length, loadUntilFull]);

  // Refresh handler - reload from scratch
  const refresh = useCallback(async () => {
    await loadUntilFull([], 0, false);
  }, [loadUntilFull]);

  // Toggle expansion for a group
  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  // Expand all groups
  const expandAll = useCallback(() => {
    setExpandedGroups(new Set(groups.map((g) => g.key)));
  }, [groups]);

  // Collapse all groups
  const collapseAll = useCallback(() => {
    setExpandedGroups(new Set());
  }, []);

  return {
    groups,
    pagination,
    isLoading,
    isLoadingMore,
    loadingProgress,
    error,
    resources,
    filters,
    loadMore,
    refresh,
    expandedGroups,
    toggleGroup,
    expandAll,
    collapseAll,
  };
}
