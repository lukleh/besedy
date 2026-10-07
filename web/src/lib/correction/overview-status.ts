export const OVERVIEW_STATUSES = [
  "not_started",
  "in_progress",
  "ready",
  "publishing",
  "published",
  "published_changed",
] as const;

/**
 * Where a recording is in the pipeline from machine text to published text.
 *
 * - `not_started`: a primary recording nobody has begun.
 * - `in_progress`: a workspace with spans that are not all done.
 * - `ready`: every span is done and nothing is published yet.
 * - `publishing`: a publication is on its way, or stuck with an error.
 * - `published`: the reader sees a snapshot that matches the live text.
 * - `published_changed`: the reader sees a snapshot, but spans have been edited
 *   since, so the live text is ahead of what readers see.
 */
export type OverviewStatus = (typeof OVERVIEW_STATUSES)[number];

export interface DeriveStatusInput {
  eligible: boolean;
  readerPublished: boolean;
  inFlight: boolean;
  changedSinceReaderPublication: number;
}

/** Pure, so the rule that a curator relies on is testable without a database. */
export function deriveOverviewStatus(input: DeriveStatusInput): OverviewStatus {
  if (input.inFlight) return "publishing";
  if (input.readerPublished) {
    return input.changedSinceReaderPublication > 0 ? "published_changed" : "published";
  }
  return input.eligible ? "ready" : "in_progress";
}
