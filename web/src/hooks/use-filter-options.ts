import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
} from "@/lib/query/auth-sensitive";

import { buildCatalogFilterParams, type CatalogFilters } from "@/components/catalog/catalog-list/filter-state";
export type { CatalogFilters } from "@/components/catalog/catalog-list/filter-state";

interface FilterOption<T> {
  value: T;
  count: number;
}

interface RecorderOption {
  id: number;
  name: string;
  count: number;
}

interface LocationOption {
  id: number;
  name: string;
  count: number;
}

interface AlbumOption {
  id: number;
  name: string;
  count: number;
}

export interface FilterOptionsResponse {
  groupId: string;
  totalMatching: number;
  options: {
    recorders: RecorderOption[];
    locations: LocationOption[];
    albums: AlbumOption[];
    parts: FilterOption<number>[];
    artists: FilterOption<string>[];
    duplicates: FilterOption<number>[];
    years: FilterOption<number>[];
    months: FilterOption<number>[];
    days: FilterOption<number>[];
    statuses: FilterOption<"ready" | "incomplete">[];
    durations: FilterOption<"short" | "medium" | "long">[];
    verified: FilterOption<boolean>[];
  };
}

const countOptionSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    count: z.number(),
  });

const namedCountOptionSchema = z.object({
  id: z.number(),
  name: z.string(),
  count: z.number(),
});

const filterOptionsResponseSchema = z.object({
  groupId: z.string(),
  totalMatching: z.number(),
  options: z.object({
    recorders: z.array(namedCountOptionSchema),
    locations: z.array(namedCountOptionSchema),
    albums: z.array(namedCountOptionSchema),
    parts: z.array(countOptionSchema(z.number())),
    artists: z.array(countOptionSchema(z.string())),
    duplicates: z.array(countOptionSchema(z.number())),
    years: z.array(countOptionSchema(z.number())),
    months: z.array(countOptionSchema(z.number())),
    days: z.array(countOptionSchema(z.number())),
    statuses: z.array(
      countOptionSchema(z.enum(["ready", "incomplete"]))
    ),
    durations: z.array(
      countOptionSchema(z.enum(["short", "medium", "long"]))
    ),
    verified: z.array(countOptionSchema(z.boolean())),
  }),
});

/**
 * Simple debounce hook
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

interface UseFilterOptionsParams {
  groupId: string | undefined;
  filters: CatalogFilters;
  enabled?: boolean;
}

/**
 * Fetch dynamic filter options based on current filter selections.
 * Options update to show only values that would return results.
 * Uses 150ms debounce to prevent excessive API calls.
 */
export function useFilterOptions({
  groupId,
  filters,
  enabled = true,
}: UseFilterOptionsParams) {
  // Debounce filters to prevent excessive API calls during rapid changes
  const debouncedFilters = useDebounce(filters, 150);

  const filterKey = buildCatalogFilterParams(debouncedFilters).toString();

  const query = useQuery<FilterOptionsResponse>({
    queryKey: ["catalog-filter-options", groupId, filterKey],
    queryFn: async () => {
      const url = `/api/catalogs/${encodeURIComponent(groupId ?? "")}/recordings/filter-options${filterKey ? `?${filterKey}` : ""}`;
      return fetchJson<FilterOptionsResponse>(url, {
        schema: filterOptionsResponseSchema,
      });
    },
    enabled: enabled && !!groupId,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  return {
    ...query,
    data: getStableAccessData(query),
    isLoading: getStableAccessLoading(query),
  };
}
