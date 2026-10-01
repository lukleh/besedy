import { useEffect, useRef } from "react";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useUpdateActiveGroup } from "@/hooks/use-update-active-group";

interface UseCatalogContextOptions {
  skipCatalogValidation?: boolean;
}

export function useCatalogContext(
  catalogId?: string,
  options?: UseCatalogContextOptions
) {
  const skipCatalogValidation = options?.skipCatalogValidation ?? false;
  const active = useActiveGroup();
  const { data: groups, isLoading: groupsLoading } = useCatalogs({
    enabled: !!catalogId,
  });
  const groupList = Array.isArray(groups) ? groups : [];
  const hasGroupData = Array.isArray(groups);
  const catalogNotFound =
    !!catalogId &&
    hasGroupData &&
    !groupList.some((group) => group.id === catalogId);
  // Server-validated pages can skip the initial blocking state while the
  // catalog list loads in the background on mount.
  const catalogValidationLoading =
    !!catalogId && !skipCatalogValidation && groupsLoading;

  const syncPreference = useUpdateActiveGroup();
  const { mutate: syncPreferenceMutate, isPending: syncPreferencePending } = syncPreference;
  // Sync each catalog once per mount. Retrying after a failed save would
  // re-run this effect as soon as the mutation settles, a request loop that
  // never backs off (offline, or while the server keeps rejecting it).
  const syncAttemptedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      catalogId &&
      !catalogValidationLoading &&
      !catalogNotFound &&
      active.isSuccess &&
      catalogId !== active.activeGroupId &&
      !syncPreferencePending &&
      syncAttemptedForRef.current !== catalogId
    ) {
      syncAttemptedForRef.current = catalogId;
      syncPreferenceMutate(catalogId);
    }
  }, [
    catalogId,
    catalogValidationLoading,
    catalogNotFound,
    active.activeGroupId,
    active.isSuccess,
    syncPreferencePending,
    syncPreferenceMutate,
  ]);

  const effectiveCatalogId = catalogId ?? active.activeGroupId;
  const groupKey = effectiveCatalogId || "default";

  return {
    ...active,
    catalogId: effectiveCatalogId,
    groupKey,
    syncingPreferences: syncPreferencePending,
    catalogNotFound,
    catalogValidationLoading,
  };
}
