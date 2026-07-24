import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  preferencesResponseSchema,
  type PreferencesResponse,
  type WorkflowGroupSummary,
} from "@/lib/preferences/client-schema";

export function useActiveGroup(options?: { enabled?: boolean }) {
  const query = useQuery<PreferencesResponse>({
    queryKey: ["preferences"],
    queryFn: () =>
      fetchJson<PreferencesResponse>("/api/preferences", {
        schema: preferencesResponseSchema,
      }),
    enabled: options?.enabled,
  });

  const activeGroupId = query.data?.activeGroupId ?? null;
  const activeGroup: WorkflowGroupSummary | null =
    query.data?.activeGroup ?? null;
  const groupKey = activeGroupId || "default";

  return {
    ...query,
    activeGroupId,
    activeGroup,
    groupKey,
  };
}
