"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson, isFinalClientError } from "@/lib/api/fetch-json";
import { AUTH_SENSITIVE_QUERY_OPTIONS } from "@/lib/query/auth-sensitive";

const CatalogAccessSummarySchema = z.object({
  canManageAccess: z.boolean(),
  canViewCorrectionOverview: z.boolean().default(false),
});

// How often a lookup that failed for a temporary reason is tried again.
const FAILED_LOOKUP_REFETCH_MS = 60_000;

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
        return { canManageAccess: false, canViewCorrectionOverview: false };
      }

      try {
        return await fetchJson<CatalogAccessSummary>(
          `/api/catalogs/${catalogId}/capability`,
          { schema: CatalogAccessSummarySchema }
        );
      } catch (error) {
        // Only a refusal is an answer. A dropped connection or a server error
        // fails the query so it is retried, instead of hiding the navigation
        // until the next full page load.
        if (isFinalClientError(error)) {
          return { canManageAccess: false, canViewCorrectionOverview: false };
        }
        throw error;
      }
    },
    enabled: (options?.enabled ?? true) && !!catalogId,
    // A server that comes back raises no reconnect event, and the header that
    // reads this never remounts, so a failed lookup is repeated until it
    // answers. A lookup that answered is not polled.
    refetchInterval: (query) =>
      query.state.status === "error" ? FAILED_LOOKUP_REFETCH_MS : false,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });
}
