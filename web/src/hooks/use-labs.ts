"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import type { LabsPreference } from "@/lib/features/labs";
import { ONE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";

const LABS_SYNC_STORAGE_KEY = "besedy:labs-updated-at";
const labsPreferenceSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().nullable(),
});

function publishLabsUpdateSyncSignal() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LABS_SYNC_STORAGE_KEY, String(Date.now()));
  } catch {
    // Ignore localStorage errors.
  }
}

/** Mount once globally to sync Labs changes across tabs. */
export function useLabsSyncListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LABS_SYNC_STORAGE_KEY) return;
      queryClient.invalidateQueries({ queryKey: ["labs-preference"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      queryClient.invalidateQueries({ queryKey: ["catalog-features"] });
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient]);
}

export function useLabs(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery<LabsPreference>({
    queryKey: ["labs-preference"],
    queryFn: () =>
      fetchJson<LabsPreference>("/api/preferences/labs", {
        schema: labsPreferenceSchema,
      }),
    enabled: options?.enabled ?? true,
    ...ONE_MINUTE_QUERY_PROFILE,
  });

  const updateMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return fetchJson<LabsPreference>("/api/preferences/labs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
        schema: labsPreferenceSchema,
      });
    },
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: ["labs-preference"] });
      const previous = queryClient.getQueryData<LabsPreference>(["labs-preference"]);

      const optimisticUpdatedAt =
        previous?.updatedAt ?? new Date().toISOString();
      queryClient.setQueryData<LabsPreference>(["labs-preference"], {
        enabled,
        updatedAt: optimisticUpdatedAt,
      });

      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["labs-preference"], context.previous);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["labs-preference"], data);
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      queryClient.invalidateQueries({ queryKey: ["catalog-features"] });
      publishLabsUpdateSyncSignal();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["labs-preference"] });
    },
  });

  const labsEnabled = query.data?.enabled ?? false;
  const updatedAt = query.data?.updatedAt ?? null;

  return {
    ...query,
    labsEnabled,
    updatedAt,
    setLabsEnabled: (enabled: boolean) => updateMutation.mutate(enabled),
    updateLabsEnabledAsync: (enabled: boolean) => updateMutation.mutateAsync(enabled),
    isUpdating: updateMutation.isPending,
  };
}
