"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  preferencesResponseSchema,
  type PreferencesResponse,
} from "@/lib/preferences/client-schema";
import { ONE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";

export type CatalogTab = "recordings" | "events";

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readSavedTab(settings: Record<string, unknown> | undefined, catalogId: string): CatalogTab {
  const rawCatalogTabs = settings?.catalogTabs;
  if (typeof rawCatalogTabs !== "object" || rawCatalogTabs === null) {
    return "events";
  }
  const saved = (rawCatalogTabs as Record<string, unknown>)[catalogId];
  return saved === "recordings" ? "recordings" : "events";
}

export function useCatalogTab(catalogId: string, canUseTabSwitcher: boolean) {
  const queryClient = useQueryClient();
  const [localTabs, setLocalTabs] = useState<Record<string, CatalogTab>>({});

  const { data: preferences } = useQuery<PreferencesResponse>({
    queryKey: ["preferences"],
    queryFn: () =>
      fetchJson<PreferencesResponse>("/api/preferences", {
        schema: preferencesResponseSchema,
      }),
    enabled: canUseTabSwitcher,
    ...ONE_MINUTE_QUERY_PROFILE,
  });

  const savedTab = useMemo(() => {
    if (!canUseTabSwitcher) return "events";
    return readSavedTab(preferences?.settings, catalogId);
  }, [catalogId, canUseTabSwitcher, preferences?.settings]);

  const activeTab: CatalogTab = !canUseTabSwitcher
    ? "events"
    : localTabs[catalogId] ?? savedTab;

  const saveTabMutation = useMutation({
    mutationFn: async (nextTab: CatalogTab) => {
      // Read current server settings at write-time so we don't overwrite unrelated keys
      // when the local preferences query is not loaded yet or is stale.
      const latest = await fetchJson<PreferencesResponse>("/api/preferences", {
        schema: preferencesResponseSchema,
      });
      const currentSettings = toRecord(latest.settings);
      const currentCatalogTabs = toRecord(currentSettings.catalogTabs);

      const nextSettings = {
        ...currentSettings,
        catalogTabs: {
          ...currentCatalogTabs,
          [catalogId]: nextTab,
        },
      };

      return fetchJson("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: nextSettings }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
    },
  });

  function updateTab(nextTab: CatalogTab) {
    if (!canUseTabSwitcher) return;

    setLocalTabs((current) => ({ ...current, [catalogId]: nextTab }));
    saveTabMutation.mutate(nextTab);
  }

  return {
    activeTab,
    setActiveTab: updateTab,
    isSaving: saveTabMutation.isPending,
  };
}
