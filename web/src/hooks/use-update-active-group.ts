import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api/fetch-json";

/**
 * Hook for updating the active group preference.
 * Centralizes the PATCH /api/preferences mutation logic used by header and catalog context.
 *
 * @param options.onSuccess - Optional callback invoked after successful update with the new groupId
 */
export function useUpdateActiveGroup(options?: {
  onSuccess?: (groupId: string) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (groupId: string) => {
      return fetchJson("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeGroupId: groupId }),
      });
    },
    onSuccess: (_data, groupId) => {
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      options?.onSuccess?.(groupId);
    },
  });
}
