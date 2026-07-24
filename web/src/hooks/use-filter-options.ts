import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
} from "@/lib/query/auth-sensitive";

/**
 * Filter criteria matching the API endpoint
 */
export interface CatalogFilters {
  status?: "ready" | "incomplete" | "all";
  duration?: "short" | "medium" | "long" | "all";
  verified?: "verified" | "unverified" | "all";
  recorder?: string; // "all" or numeric ID as string
  location?: string; // "all" or numeric ID as string
  album?: string; // "all" or numeric ID as string
  part?: string; // "all" or numeric as string
  dateYear?: string; // "all" or year as string
  dateMonth?: string; // "all" or month as string
  dateDay?: string; // "all" or day as string
  artist?: string; // "all" or artist name
  duplicates?: string; // "all" or count as string
}

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

/**
 * Convert frontend filter values to API query params
 */
function filtersToParams(filters: CatalogFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  if (filters.duration && filters.duration !== "all") {
    params.set("duration", filters.duration);
  }
  if (filters.verified && filters.verified !== "all") {
    params.set("verified", filters.verified === "verified" ? "true" : "false");
  }
  if (filters.recorder && filters.recorder !== "all") {
    params.set("recorder", filters.recorder);
  }
  if (filters.location && filters.location !== "all") {
    params.set("location", filters.location);
  }
  if (filters.part && filters.part !== "all") {
    params.set("part", filters.part);
  }
  if (filters.dateYear && filters.dateYear !== "all") {
    params.set("dateYear", filters.dateYear);
  }
  if (filters.dateMonth && filters.dateMonth !== "all") {
    params.set("dateMonth", filters.dateMonth);
  }
  if (filters.dateDay && filters.dateDay !== "all") {
    params.set("dateDay", filters.dateDay);
  }
  if (filters.artist && filters.artist !== "all") {
    params.set("artist", filters.artist);
  }
  if (filters.album && filters.album !== "all") {
    params.set("album", filters.album);
  }
  if (filters.duplicates && filters.duplicates !== "all") {
    params.set("duplicates", filters.duplicates);
  }

  return params;
}

/**
 * Normalize filters to a stable key for caching
 * Only includes non-default values
 */
function normalizeFiltersForKey(filters: CatalogFilters): Record<string, string> {
  const result: Record<string, string> = {};

  if (filters.status && filters.status !== "all") result.status = filters.status;
  if (filters.duration && filters.duration !== "all") result.duration = filters.duration;
  if (filters.verified && filters.verified !== "all") result.verified = filters.verified;
  if (filters.recorder && filters.recorder !== "all") result.recorder = filters.recorder;
  if (filters.location && filters.location !== "all") result.location = filters.location;
  if (filters.part && filters.part !== "all") result.part = filters.part;
  if (filters.dateYear && filters.dateYear !== "all") result.dateYear = filters.dateYear;
  if (filters.dateMonth && filters.dateMonth !== "all") result.dateMonth = filters.dateMonth;
  if (filters.dateDay && filters.dateDay !== "all") result.dateDay = filters.dateDay;
  if (filters.artist && filters.artist !== "all") result.artist = filters.artist;
  if (filters.album && filters.album !== "all") result.album = filters.album;
  if (filters.duplicates && filters.duplicates !== "all") result.duplicates = filters.duplicates;

  return result;
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

  // Normalize for stable query key
  const normalizedFilters = useMemo(
    () => normalizeFiltersForKey(debouncedFilters),
    [debouncedFilters]
  );

  const query = useQuery<FilterOptionsResponse>({
    queryKey: ["catalog-filter-options", groupId, normalizedFilters],
    queryFn: async () => {
      const params = filtersToParams(debouncedFilters);
      if (groupId) {
        params.set("group", groupId);
      }
      const url = `/api/catalog/filter-options${params.toString() ? `?${params}` : ""}`;
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
