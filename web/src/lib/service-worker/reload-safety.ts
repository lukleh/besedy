export type ReloadBlockerKind =
  | "audio"
  | "unsaved-changes"
  | "critical-mutation"
  /** An offline download is in flight; an automatic reload would interrupt it. */
  | "download";

export const RELOAD_BLOCKER_KINDS: readonly ReloadBlockerKind[] = [
  "audio",
  "unsaved-changes",
  "critical-mutation",
  "download",
];

export function isReloadBlockerKind(value: unknown): value is ReloadBlockerKind {
  return typeof value === "string" && (RELOAD_BLOCKER_KINDS as readonly string[]).includes(value);
}

export interface ReloadSafetySummary {
  automaticBlockerKinds: ReloadBlockerKind[];
  manualBlockerKinds: ReloadBlockerKind[];
}

export const EMPTY_RELOAD_SAFETY_SUMMARY: ReloadSafetySummary = {
  automaticBlockerKinds: [],
  manualBlockerKinds: [],
};
