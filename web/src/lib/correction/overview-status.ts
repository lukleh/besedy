/**
 * Where a recording stands, on two axes that move independently.
 *
 * The work: has correction begun, and is every span done? The reader: what
 * do listeners see? A published recording can be corrected again, and a
 * finished one can wait for publication, so neither axis is a stage of the
 * other. Folding them into one status hid re-correction of published
 * recordings from the work in progress.
 *
 * Pure, so the rules a curator relies on are testable without a database and
 * shared by the server's summary and the page's tabs.
 */

export const WORK_STAGES = ["not_started", "in_progress", "done"] as const;

/**
 * - `not_started`: a primary recording nobody has begun.
 * - `in_progress`: a workspace with spans that are not all done.
 * - `done`: every span is done; the live text can be published.
 */
export type WorkStage = (typeof WORK_STAGES)[number];

export const READER_STATES = ["unpublished", "publishing", "current", "stale"] as const;

/**
 * - `unpublished`: readers see the machine transcript.
 * - `publishing`: a publication is on its way, or stuck with an error.
 * - `current`: readers see a snapshot that matches the live text.
 * - `stale`: readers see a snapshot, but spans have been edited since.
 */
export type ReaderState = (typeof READER_STATES)[number];

export function deriveWorkStage(input: { hasWorkspace: boolean; eligible: boolean }): WorkStage {
  if (!input.hasWorkspace) return "not_started";
  return input.eligible ? "done" : "in_progress";
}

export function deriveReaderState(input: {
  readerPublished: boolean;
  inFlight: boolean;
  changedSinceReaderPublication: number;
}): ReaderState {
  if (input.inFlight) return "publishing";
  if (!input.readerPublished) return "unpublished";
  return input.changedSinceReaderPublication > 0 ? "stale" : "current";
}

export const OVERVIEW_TABS = ["mine", "in_progress", "to_publish", "published", "not_started"] as const;

export type OverviewTab = (typeof OVERVIEW_TABS)[number];

/** What tab membership needs to know about a recording. */
export interface OverviewTabInput {
  work: WorkStage;
  reader: ReaderState;
  touchedByMe: boolean;
  mine: { open: number } | null;
}

/** Live text that readers do not see yet and that may be published. */
export function isReadyToPublish(item: Pick<OverviewTabInput, "work" | "reader">): boolean {
  return item.work === "done" && (item.reader === "unpublished" || item.reader === "stale");
}

/** Which tabs a recording appears under; one recording can be in more than one. */
export function inOverviewTab(item: OverviewTabInput, tab: OverviewTab): boolean {
  switch (tab) {
    case "mine":
      return item.touchedByMe && (item.mine?.open ?? 0) > 0;
    case "in_progress":
      return item.work === "in_progress";
    case "to_publish":
      return item.reader === "publishing" || isReadyToPublish(item);
    case "published":
      return item.reader === "current" || item.reader === "stale";
    case "not_started":
      return item.work === "not_started";
  }
}
