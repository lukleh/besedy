"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import { AUTH_SENSITIVE_QUERY_OPTIONS } from "@/lib/query/auth-sensitive";

const CatalogAccessSummarySchema = z.object({
  canManageAccess: z.boolean(),
});

export type CatalogAccessSummary = z.infer<typeof CatalogAccessSummarySchema>;

interface UseCatalogAccessSummaryOptions {
  enabled?: boolean;
}

export function useCatalogAccessSummary(
  catalogId: string | null,
  options?: UseCatalogAccessSummaryOptions
) {
  return useQuery<CatalogAccessSummary>({
    queryKey: ["catalog-access-summary", catalogId],
    queryFn: async () => {
      if (!catalogId) {
        return { canManageAccess: false };
      }

      try {
        return await fetchJson<CatalogAccessSummary>(
          `/api/catalogs/${catalogId}/capability`,
          { schema: CatalogAccessSummarySchema }
        );
      } catch {
        return { canManageAccess: false };
      }
    },
    enabled: (options?.enabled ?? true) && !!catalogId,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });
}
