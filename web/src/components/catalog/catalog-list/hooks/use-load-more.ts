"use client";

import { useProgressiveList } from "@/hooks/use-progressive-list";
import type { CatalogEntry, CatalogResponse, PaginationInfo } from "../types";
import { catalogResponseSchema } from "../types";
import {
  buildCatalogParams,
  catalogRecordingsUrl,
  type CatalogFilterParams,
} from "../utils";
import { fetchJson } from "@/lib/api/fetch-json";

interface UseLoadMoreOptions {
  activeCatalogId: string | null | undefined;
  filters: CatalogFilterParams;
  currentPage: number;
  currentEntries: CatalogEntry[];
  pagination: PaginationInfo | undefined;
  baseDataUpdatedAt?: number;
}

export function useLoadMore({
  activeCatalogId,
  filters,
  ...options
}: UseLoadMoreOptions) {
  return useProgressiveList({
    ...options,
    requestKey: JSON.stringify([
      activeCatalogId,
      buildCatalogParams(filters, options.currentPage, 50).toString(),
    ]),
    fetchPage: async (page, limit, signal) => {
      const data = await fetchJson<CatalogResponse>(
        catalogRecordingsUrl(
          activeCatalogId,
          buildCatalogParams(filters, page, limit),
        ),
        { signal, schema: catalogResponseSchema },
      );
      return data.entries;
    },
  });
}
