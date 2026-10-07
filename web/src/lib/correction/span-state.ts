/**
 * The four span states are derived, never stored. A stored status would be a
 * second source of truth that can drift from the decisions underneath it.
 *
 * The derivation itself lives in one place, `span-state-sql.ts`: every page,
 * count and publication check reads states from that query rather than
 * reducing decisions a second time in application code.
 */
export const SPAN_STATES = [
  "needs_attention",
  "done",
  "needs_second_approval",
  "not_reviewed",
] as const;

export type SpanState = (typeof SPAN_STATES)[number];

/** v1 fixes the threshold at two distinct people and offers no way to change it. */
export const REQUIRED_APPROVALS = 2;

export interface SpanDecisionSummary {
  /** Actor keys, so a deleted account still counts as the person it was */
  approverIds: string[];
  disapproverIds: string[];
  state: SpanState;
  isDone: boolean;
}
