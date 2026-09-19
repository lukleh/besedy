import type { RolloutMode } from "@/lib/features/rollout";

export interface FeatureCapability {
  rollout: RolloutMode;
  // Rollout availability for the feature itself. Actor-level access is exposed
  // separately via fields like `canView`.
  enabled: boolean;
  canView: boolean;
  canEdit: boolean;
  showTabs: boolean;
  showAllColumns: boolean;
  showReleaseState: boolean;
  canUseRagSearch: boolean;
}

export interface DeepSearchFeatureCapability {
  rollout: RolloutMode;
  enabled: boolean;
  canView: boolean;
}

/** The recordings list as a surface, rather than a feature with a rollout. */
export interface RecordingsCapability {
  canBrowse: boolean;
}

export interface CatalogFeaturesResponse {
  labsEnabled: boolean;
  features: {
    events: FeatureCapability;
    deepSearch: DeepSearchFeatureCapability;
    recordings: RecordingsCapability;
  };
}
