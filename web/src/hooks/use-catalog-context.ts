import { useEffect } from "react";
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

  useEffect(() => {
    if (
      catalogId &&
      !catalogValidationLoading &&
      !catalogNotFound &&
      !active.isLoading &&
      catalogId !== active.activeGroupId &&
      !syncPreferencePending
    ) {
      syncPreferenceMutate(catalogId);
    }
  }, [
    catalogId,
    catalogValidationLoading,
    catalogNotFound,
    active.activeGroupId,
    active.isLoading,
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
