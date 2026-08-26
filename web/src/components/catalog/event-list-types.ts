import { z } from "zod";
import type { PaginationInfo } from "@/components/catalog/catalog-list/types";
import type { PlaybackProgressSummary } from "@/lib/playback-progress";

export interface EventListProps {
  catalogId: string;
  canEdit: boolean;
  showAllColumns: boolean;
  showReleaseState: boolean;
  canUseRagSearch: boolean;
  deepSearchHref?: string;
}

export interface LocationItem {
  id: number;
  name: string;
}

export interface CatalogEventRow {
  id: number;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  released: boolean;
  recordingCount: number;
  sourceCount: number;
  posterStatus: {
    portrait: boolean;
    landscape: boolean;
  };
  primaryTitle: string | null;
  playback: PlaybackProgressSummary | null;
}

export interface EventListResponse {
  events: CatalogEventRow[];
  filterOptions: {
    years: number[];
    locations: LocationItem[];
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalAll: number;
    totalPages: number;
  };
}

export const locationItemSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const catalogEventRowSchema = z.object({
  id: z.number(),
  title: z.string().nullable(),
  location: z
    .object({
      id: z.number(),
      name: z.string(),
    })
    .nullable(),
  dateYear: z.number(),
  dateMonth: z.number().nullable(),
  dateDay: z.number().nullable(),
  sessionIndex: z.number(),
  released: z.boolean(),
  recordingCount: z.number(),
  sourceCount: z.number(),
  posterStatus: z.object({
    portrait: z.boolean(),
    landscape: z.boolean(),
  }),
  primaryTitle: z.string().nullable(),
  playback: z
    .object({
      positionSec: z.number(),
      durationSec: z.number().nullable(),
      percent: z.number(),
      completed: z.boolean(),
    })
    .nullable(),
});

export const eventListResponseSchema = z.object({
  events: z.array(catalogEventRowSchema),
  filterOptions: z.object({
    years: z.array(z.number()),
    locations: z.array(locationItemSchema),
  }),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalAll: z.number(),
    totalPages: z.number(),
  }),
});

export interface CreateEventPayload {
  workflowGroupId: string;
  locationId: number;
  dateYear: number;
  dateMonth?: number | null;
  dateDay?: number | null;
  sessionIndex?: number;
  title?: string | null;
  description?: string | null;
}

export type EventSortKey = "date" | "location" | "recordingCount" | "released";
export type SortDirection = "asc" | "desc";

export interface EventListQueryState {
  releasedFilter: "all" | "true" | "false";
  locationFilter: string;
  dateYearFilter: string;
  sortKey: EventSortKey;
  sortDir: SortDirection;
}

export interface StoredEventListState {
  releasedFilter?: "all" | "true" | "false";
  locationFilter?: string;
  dateYearFilter?: string;
  sortKey?: EventSortKey;
  sortDir?: SortDirection;
  page?: number;
}

export function toPaginationInfo(
  pagination: EventListResponse["pagination"],
): PaginationInfo {
  return {
    page: pagination.page,
    limit: pagination.limit,
    totalPages: pagination.totalPages,
    hasPrevPage: pagination.page > 1,
    hasNextPage: pagination.page < pagination.totalPages,
  };
}
