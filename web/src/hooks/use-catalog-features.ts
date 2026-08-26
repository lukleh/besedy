"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import type { CatalogFeaturesResponse } from "@/lib/features/types";
import { FIVE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";

const featureCapabilitySchema = z.object({
  rollout: z.enum(["off", "labs", "public"]),
  enabled: z.boolean(),
  canView: z.boolean(),
  canEdit: z.boolean(),
  showTabs: z.boolean(),
  showAllColumns: z.boolean(),
  showReleaseState: z.boolean(),
  canUseRagSearch: z.boolean(),
});

const deepSearchFeatureCapabilitySchema = z.object({
  rollout: z.enum(["off", "labs", "public"]),
  enabled: z.boolean(),
  canView: z.boolean(),
});

const catalogFeaturesResponseSchema = z.object({
  labsEnabled: z.boolean(),
  features: z.object({
    events: featureCapabilitySchema,
    deepSearch: deepSearchFeatureCapabilitySchema,
  }),
});

export function useCatalogFeatures(
  catalogId: string,
  options?: {
    enabled?: boolean;
    includeInactive?: boolean;
  }
) {
  const includeInactive = options?.includeInactive === true;

  return useQuery<CatalogFeaturesResponse>({
    queryKey: ["catalog-features", catalogId, includeInactive],
    queryFn: () =>
      fetchJson<CatalogFeaturesResponse>(
        `/api/catalogs/${catalogId}/features${
          includeInactive ? "?includeInactive=true" : ""
        }`,
        {
          schema: catalogFeaturesResponseSchema,
        }
      ),
    enabled: (options?.enabled ?? true) && catalogId.length > 0,
    ...FIVE_MINUTE_QUERY_PROFILE,
  });
}
