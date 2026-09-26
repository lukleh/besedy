import type { TranscriptDecisionKind } from "@/generated/prisma/client";

/**
 * The four span states are derived, never stored. A stored status would be a
 * second source of truth that can drift from the decisions underneath it.
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

export interface DecisionRow {
  /** Immutable actor identity; equal to the user id while that account exists */
  actorKey: string;
  kind: TranscriptDecisionKind;
  createdAt: Date;
}

export interface SpanDecisionSummary {
  /** Actor keys, so a deleted account still counts as the person it was */
  approverIds: string[];
  disapproverIds: string[];
  state: SpanState;
  isDone: boolean;
}

/**
 * Reduce a span's decision history on its current revision to one effective
 * decision per person: the last row wins, and a withdrawal leaves that
 * person with none.
 *
 * Callers pass decisions in write order (the stored sequence), and only those
 * bound to the current revision. Timestamps are not consulted: they have
 * millisecond precision and can tie, and a tie broken the wrong way would
 * revive an approval the person had withdrawn. Decisions on superseded
 * revisions never count, which is what stops an old approval from reviving
 * when text returns to earlier wording.
 */
export function summarizeSpanDecisions(
  decisions: readonly DecisionRow[]
): SpanDecisionSummary {
  const effective = new Map<string, DecisionRow>();

  for (const decision of decisions) {
    effective.set(decision.actorKey, decision);
  }

  const approverIds: string[] = [];
  const disapproverIds: string[] = [];

  for (const [actorKey, decision] of effective) {
    if (decision.kind === "APPROVE") approverIds.push(actorKey);
    else if (decision.kind === "DISAPPROVE") disapproverIds.push(actorKey);
  }

  approverIds.sort();
  disapproverIds.sort();

  const state = deriveSpanState(approverIds.length, disapproverIds.length);

  return {
    approverIds,
    disapproverIds,
    state,
    isDone: state === "done",
  };
}

/**
 * Evaluated in order, so an objection is never outvoted: extra approvals do
 * not carry a span past someone who currently disapproves of it.
 */
export function deriveSpanState(
  approvals: number,
  disapprovals: number
): SpanState {
  if (disapprovals > 0) return "needs_attention";
  if (approvals >= REQUIRED_APPROVALS) return "done";
  if (approvals > 0) return "needs_second_approval";
  return "not_reviewed";
}

/** A span counts as reviewed once anyone has taken a position on it. */
export function hasBeenReviewed(summary: SpanDecisionSummary): boolean {
  return summary.approverIds.length > 0 || summary.disapproverIds.length > 0;
}
