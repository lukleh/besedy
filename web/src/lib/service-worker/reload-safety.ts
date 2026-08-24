export type ReloadBlockerKind = "audio" | "unsaved-changes" | "critical-mutation";

export interface ReloadSafetySummary {
  automaticBlockerKinds: ReloadBlockerKind[];
  manualBlockerKinds: ReloadBlockerKind[];
}

export const EMPTY_RELOAD_SAFETY_SUMMARY: ReloadSafetySummary = {
  automaticBlockerKinds: [],
  manualBlockerKinds: [],
};
