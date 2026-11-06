import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { type CatalogFeaturesResponse } from "@/lib/features/types";
import {
  canBrowseRecordings,
  canUseCatalogRag,
} from "@/lib/policy/catalog";
import { canBrowseEvents, canEditCatalogEvents } from "@/lib/policy/event";
import {
  canSeeAllEventColumns,
  canSeeReleaseState,
  canUseCatalogTabSwitcher,
} from "@/lib/policy/ui";

export function buildCatalogFeaturesResponse(
  catalogGrant: CatalogGrant | null,
  isCatalogAdmin: boolean,
  options: {
    catalogExists?: boolean;
    canEnterPortal?: boolean;
  } = {}
): CatalogFeaturesResponse {
  const catalogExists =
    options.catalogExists ?? (catalogGrant !== null || isCatalogAdmin);
  const canEnterPortal =
    options.canEnterPortal ?? (catalogGrant !== null || isCatalogAdmin);
  const recordingBrowse = canBrowseRecordings({
    catalogExists,
    canEnterPortal,
    catalogGrant,
    isCatalogAdmin,
  });
  const catalogPolicyContext = {
    catalogExists,
    canEnterPortal,
    catalogGrant,
    isCatalogAdmin,
  };
  const canView = canBrowseEvents(catalogPolicyContext);
  const canEdit = canEditCatalogEvents(catalogPolicyContext);
  const showTabs = canUseCatalogTabSwitcher({
    canBrowseRecordings: recordingBrowse,
    canBrowseEvents: canView,
    canEditEvents: canEdit,
  });

  return {
    features: {
      events: {
        canView,
        canEdit,
        showTabs,
        showAllColumns: canSeeAllEventColumns({
          catalogGrant,
          isCatalogAdmin,
        }),
        showReleaseState: canSeeReleaseState({
          catalogGrant,
          isCatalogAdmin,
        }),
        canUseRagSearch: canUseCatalogRag(catalogPolicyContext),
      },
      recordings: {
        canBrowse: recordingBrowse,
      },
    },
  };
}

export async function getCatalogFeaturesForUser(
  catalogId: string,
  userId: string,
  options: {
    activeCatalogOnly?: boolean;
  } = {}
): Promise<{ catalogExists: boolean; data: CatalogFeaturesResponse }> {
  const catalogCapability = await getCatalogCapability(catalogId, userId, options);

  if (!catalogCapability.catalogExists) {
    return {
      catalogExists: false,
      data: buildCatalogFeaturesResponse(null, false),
    };
  }

  return {
    catalogExists: true,
    data: buildCatalogFeaturesResponse(
      catalogCapability.catalogGrant,
      catalogCapability.isCatalogAdmin,
      {
        catalogExists: catalogCapability.catalogExists,
        canEnterPortal: catalogCapability.canEnterPortal,
      }
    ),
  };
}
