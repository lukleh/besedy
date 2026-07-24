export type RolloutMode = "off" | "labs" | "public";
export type FeatureKey = "events" | "deep-search";

export const FEATURE_ROLLOUT: Record<FeatureKey, RolloutMode> = {
  events: "public",
  "deep-search": "labs",
};

export function getFeatureRollout(feature: FeatureKey): RolloutMode {
  return FEATURE_ROLLOUT[feature];
}
