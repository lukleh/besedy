/**
 * What makes an automatic update wait: something running that a reload would
 * interrupt. An update the person asks for is never held back. Unsaved edits
 * do not block updates; correction drafts are stored and survive a reload.
 */
export type ReloadBlockerKind =
  | "audio"
  /** An offline download is in flight; an automatic reload would interrupt it. */
  | "download";

export const RELOAD_BLOCKER_KINDS: readonly ReloadBlockerKind[] = ["audio", "download"];

export function isReloadBlockerKind(value: unknown): value is ReloadBlockerKind {
  return typeof value === "string" && (RELOAD_BLOCKER_KINDS as readonly string[]).includes(value);
}

export interface ReloadSafetySummary {
  automaticBlockerKinds: ReloadBlockerKind[];
}

export const EMPTY_RELOAD_SAFETY_SUMMARY: ReloadSafetySummary = {
  automaticBlockerKinds: [],
};
