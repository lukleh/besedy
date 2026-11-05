export interface FeatureCapability {
  canView: boolean;
  canEdit: boolean;
  showTabs: boolean;
  showAllColumns: boolean;
  showReleaseState: boolean;
  canUseRagSearch: boolean;
}

/** Access to the recordings list surface. */
export interface RecordingsCapability {
  canBrowse: boolean;
}

export interface CatalogFeaturesResponse {
  features: {
    events: FeatureCapability;
    recordings: RecordingsCapability;
  };
}
