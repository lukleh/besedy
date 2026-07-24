"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { CatalogEntryWithPermissions } from "@/types/catalog";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
  isAwaitingFreshAccessData,
} from "@/lib/query/auth-sensitive";

interface UseRecordingEntryParams {
  catalogId: string;
  hash: string;
  groupKey: string | null | undefined;
  enabled: boolean;
}

const catalogEntryWithPermissionsSchema = z.object({
  entry: z.object({
    hash: z.string(),
    hasArchived: z.boolean(),
    hasMetadata: z.boolean(),
    isActionable: z.boolean(),
    isPublished: z.boolean(),
    hasArchivedAudio: z.boolean(),
    hasOriginalAudio: z.boolean(),
  }).passthrough(),
  canViewTranscripts: z.boolean(),
  canEditMetadata: z.boolean(),
  canDownload: z.boolean(),
}).passthrough();

export function useRecordingEntry({
  catalogId,
  hash,
  groupKey,
  enabled,
}: UseRecordingEntryParams) {
  const query = useQuery<CatalogEntryWithPermissions>({
    queryKey: ["catalog-entry", hash, groupKey],
    queryFn: async () => {
      return fetchJson<CatalogEntryWithPermissions>(
        `/api/catalogs/${catalogId}/recordings/${hash}/entry`,
        {
          schema: catalogEntryWithPermissionsSchema,
        }
      );
    },
    enabled,
    retry: false,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  return {
    ...query,
    cachedData: query.data,
    data: getStableAccessData(query),
    isLoading: getStableAccessLoading(query),
    isValidatingAccess: isAwaitingFreshAccessData(query),
  };
}
