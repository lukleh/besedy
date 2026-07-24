"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  CatalogResponse,
  ColumnKey,
  StatusFilter,
  DurationFilter,
  VerifiedFilter,
  SortDirection,
} from "../types";
import { catalogResponseSchema } from "../types";
import { buildCatalogParams } from "../utils";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
} from "@/lib/query/auth-sensitive";

interface UseCatalogDataOptions {
  groupKey: string | null | undefined;
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
  page: number;
  visibleColumnKeys: ColumnKey[];
  enabled: boolean;
}

export function useCatalogData({
  groupKey,
  activeCatalogId,
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
  visibleColumnKeys,
  enabled,
}: UseCatalogDataOptions) {
  const query = useQuery<CatalogResponse>({
    queryKey: [
      "catalog",
      groupKey,
      page,
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
      visibleColumnKeys.join(","),
    ],
    queryFn: async () => {
      // Note: Filters are applied regardless of column visibility to support URL sharing
      const params = buildCatalogParams(
        {
          activeCatalogId,
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
        },
        page,
        50
      );
      return fetchJson<CatalogResponse>(`/api/catalog?${params.toString()}`, {
        schema: catalogResponseSchema,
      });
    },
    enabled,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  return {
    ...query,
    data: getStableAccessData(query),
    isLoading: getStableAccessLoading(query),
  };
}
