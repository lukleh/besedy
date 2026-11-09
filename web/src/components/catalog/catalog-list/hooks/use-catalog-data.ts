"use client";

import { useQuery } from "@tanstack/react-query";
import type { CatalogResponse } from "../types";
import type { CatalogFilterParams } from "../utils";
import { catalogResponseSchema } from "../types";
import { buildCatalogParams, catalogRecordingsUrl } from "../utils";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
} from "@/lib/query/auth-sensitive";

interface UseCatalogDataOptions {
  activeCatalogId: string | null | undefined;
  filters: CatalogFilterParams;
  page: number;
  enabled: boolean;
}

export function useCatalogData({
  activeCatalogId,
  filters,
  page,
  enabled,
}: UseCatalogDataOptions) {
  const params = buildCatalogParams(filters, page, 50);
  const requestKey = params.toString();
  const query = useQuery<CatalogResponse>({
    queryKey: ["catalog", activeCatalogId, requestKey],
    queryFn: ({ signal }) =>
      fetchJson<CatalogResponse>(
        catalogRecordingsUrl(activeCatalogId, params),
        {
          schema: catalogResponseSchema,
          signal,
        },
      ),
    enabled,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  return {
    ...query,
    data: getStableAccessData(query),
    isLoading: getStableAccessLoading(query),
  };
}
