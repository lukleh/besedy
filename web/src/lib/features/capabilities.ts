import type { AccessLevel } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { getCatalogCapability } from "@/lib/access/capabilities";
import {
  type LabsPreference,
  defaultLabsPreference,
  readLabsPreferenceFromSettings,
} from "@/lib/features/labs";
import { type FeatureKey, getFeatureRollout } from "@/lib/features/rollout";
import { type CatalogFeaturesResponse } from "@/lib/features/types";
import { canBrowseRecordings, canUseCatalogRag } from "@/lib/policy/catalog";
import {
  canBrowseEvents,
  canEditCatalogEvents,
} from "@/lib/policy/event";
import {
  canSeeAllEventColumns,
  canSeeReleaseState,
  canUseCatalogTabSwitcher,
} from "@/lib/policy/ui";

export function isFeatureEnabledForUser(feature: FeatureKey, labsEnabled: boolean): boolean {
  const rollout = getFeatureRollout(feature);
  if (rollout === "public") return true;
  if (rollout === "off") return false;
  return labsEnabled;
}

export interface UserFeaturePreferences {
  activeGroupId: string | null;
  labsPreference: LabsPreference;
}

export async function getUserFeaturePreferences(
  userId: string
): Promise<UserFeaturePreferences> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { activeGroupId: true, settings: true },
  });

  if (!prefs) {
    return {
      activeGroupId: null,
      labsPreference: defaultLabsPreference(),
    };
  }

  return {
    activeGroupId: prefs.activeGroupId,
    labsPreference: readLabsPreferenceFromSettings(prefs.settings),
  };
}

export async function getLabsPreferenceForUser(
  userId: string
): Promise<LabsPreference> {
  return (await getUserFeaturePreferences(userId)).labsPreference;
}

export function buildCatalogFeaturesResponse(
  catalogGrant: AccessLevel | null,
  labsEnabled: boolean,
  isCatalogAdmin: boolean,
  options: {
    catalogExists?: boolean;
    canEnterPortal?: boolean;
  } = {}
): CatalogFeaturesResponse {
  const catalogExists = options.catalogExists ?? (catalogGrant !== null || isCatalogAdmin);
  const canEnterPortal = options.canEnterPortal ?? (catalogGrant !== null || isCatalogAdmin);
  const rollout = getFeatureRollout("events");
  const featureEnabled = isFeatureEnabledForUser("events", labsEnabled);
  const deepSearchRollout = getFeatureRollout("deep-search");
  const deepSearchEnabled = isFeatureEnabledForUser("deep-search", labsEnabled);
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
  const eventPolicyContext = {
    featureEnabled,
    ...catalogPolicyContext,
  };
  const canView = canBrowseEvents(eventPolicyContext);
  const canEdit = canEditCatalogEvents(eventPolicyContext);
  const showTabs = canUseCatalogTabSwitcher({
    canBrowseRecordings: recordingBrowse,
    canBrowseEvents: canView,
    canEditEvents: canEdit,
  });

  return {
    labsEnabled,
    features: {
      events: {
        rollout,
        enabled: featureEnabled,
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
      deepSearch: {
        rollout: deepSearchRollout,
        enabled: deepSearchEnabled,
        canView:
          deepSearchEnabled &&
          catalogExists &&
          canEnterPortal &&
          (isCatalogAdmin || catalogGrant === "OWNER"),
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
  const [catalogCapability, labsPreference] = await Promise.all([
    getCatalogCapability(catalogId, userId, options),
    getLabsPreferenceForUser(userId),
  ]);

  if (!catalogCapability.catalogExists) {
    return {
      catalogExists: false,
      data: buildCatalogFeaturesResponse(null, false, false),
    };
  }

  return {
    catalogExists: true,
    data: buildCatalogFeaturesResponse(
      catalogCapability.catalogGrant,
      labsPreference.enabled,
      catalogCapability.isCatalogAdmin,
      {
        catalogExists: catalogCapability.catalogExists,
        canEnterPortal: catalogCapability.canEnterPortal,
      }
    ),
  };
}

export async function canAccessCatalogDeepSearch(
  userId: string,
  catalogId: string,
  options: {
    activeCatalogOnly?: boolean;
  } = {}
): Promise<boolean> {
  const { catalogExists, data } = await getCatalogFeaturesForUser(
    catalogId,
    userId,
    options
  );
  return catalogExists && data.features.deepSearch.canView;
}
