import { z } from "zod";
import type { MetadataRecorder, MetadataLocation } from "@/hooks/use-metadata-enums";

export interface CatalogEntry {
  hash: string;
  filename?: string;
  duration?: string;
  title?: string;
  curatedTitle?: string | null;
  artist?: string;
  curatedArtist?: string | null;
  albumId?: number | null;
  album?: { id: number; name: string } | null;
  date?: string;
  curatedDate?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
  hasArchivedAudio: boolean;
  hasOriginalAudio: boolean;
  curated?: boolean;
  verified?: boolean;
  verifiedAt?: string | null;
  tags?: string[];
  notes?: string | null;
  recorderId?: number | null;
  recorder?: MetadataRecorder | null;
  locationId?: number | null;
  location?: MetadataLocation | null;
  part?: number | null;
  duplicateCount?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface CatalogFilterOptions {
  parts: number[];
  dateParts: { year: number; month: number | null; day: number | null }[];
}

export interface CatalogResponse {
  groupId: string;
  groupLabel: string | null;
  lastModifiedAt?: string;
  totalAll?: number;
  total: number;
  actionable: number;
  verified: number;
  entries: CatalogEntry[];
  filters?: CatalogFilterOptions;
  pagination: PaginationInfo;
  canBatchEditMetadata?: boolean;
  canManageAccess?: boolean;
  canUseRagSearch?: boolean;
  accessLevel?: string;
}

const metadataRecorderSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const metadataLocationSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const catalogEntrySchema = z.object({
  hash: z.string(),
  filename: z.string().optional(),
  duration: z.string().optional(),
  title: z.string().optional(),
  curatedTitle: z.string().nullable().optional(),
  artist: z.string().optional(),
  curatedArtist: z.string().nullable().optional(),
  albumId: z.number().nullable().optional(),
  album: z
    .object({
      id: z.number(),
      name: z.string(),
    })
    .nullable()
    .optional(),
  date: z.string().optional(),
  curatedDate: z.string().nullable().optional(),
  dateYear: z.number().nullable().optional(),
  dateMonth: z.number().nullable().optional(),
  dateDay: z.number().nullable().optional(),
  hasArchived: z.boolean(),
  hasMetadata: z.boolean(),
  isActionable: z.boolean(),
  isPublished: z.boolean(),
  hasArchivedAudio: z.boolean(),
  hasOriginalAudio: z.boolean(),
  curated: z.boolean().optional(),
  verified: z.boolean().optional(),
  verifiedAt: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
  recorderId: z.number().nullable().optional(),
  recorder: metadataRecorderSchema.nullable().optional(),
  locationId: z.number().nullable().optional(),
  location: metadataLocationSchema.nullable().optional(),
  part: z.number().nullable().optional(),
  duplicateCount: z.number().optional(),
});

export const catalogResponseSchema = z.object({
  groupId: z.string(),
  groupLabel: z.string().nullable(),
  lastModifiedAt: z.string().optional(),
  totalAll: z.number().optional(),
  total: z.number(),
  actionable: z.number(),
  verified: z.number(),
  entries: z.array(catalogEntrySchema),
  filters: z
    .object({
      parts: z.array(z.number()),
      dateParts: z.array(
        z.object({
          year: z.number(),
          month: z.number().nullable(),
          day: z.number().nullable(),
        })
      ),
    })
    .optional(),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    hasNextPage: z.boolean(),
    hasPrevPage: z.boolean(),
  }),
  canBatchEditMetadata: z.boolean().optional(),
  canManageAccess: z.boolean().optional(),
  canUseRagSearch: z.boolean().optional(),
  accessLevel: z.string().optional(),
});

export type StatusFilter = "all" | "ready" | "incomplete";
export type DurationFilter = "all" | "short" | "medium" | "long";
export type VerifiedFilter = "all" | "verified" | "unverified";
export type SortDirection = "asc" | "desc";

export type ColumnKey =
  | "title"
  | "date"
  | "artist"
  | "album"
  | "duration"
  | "status"
  | "recorder"
  | "location"
  | "part"
  | "verified"
  | "duplicates"
  | "offline";

export interface ColumnConfig {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
}

export interface StoredFilters {
  status?: string;
  duration?: string;
  verified?: string;
  recorder?: string;
  location?: string;
  part?: string;
  dateYear?: string;
  dateMonth?: string;
  dateDay?: string;
  artist?: string;
  album?: string;
  duplicates?: string;
  sortKey?: string;
  sortDir?: string;
  page?: number;
}

export interface CatalogListProps {
  catalogId?: string;
  deepSearchHref?: string;
}
