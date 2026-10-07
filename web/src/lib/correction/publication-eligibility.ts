import type { Prisma } from "@/generated/prisma/client";
import { loadSpanSummaries, type SpanSummaryRow } from "@/lib/correction/span-summaries";
import type { WorkspaceAggregate } from "@/lib/correction/span-queries";

export interface ManifestEntry {
  spanId: string;
  revisionId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface PublicationEligibility {
  eligible: boolean;
  spanCount: number;
  doneSpanCount: number;
  blockedSpanCount: number;
  unreviewedSpanCount: number;
  awaitingSecondApprovalCount: number;
}

export interface WorkspaceEvaluation extends PublicationEligibility {
  manifest: ManifestEntry[];
  durationSeconds: number;
}

/**
 * The publication rule, stated once: every span is done *and* carries a
 * revision. A span without a current revision cannot appear in a manifest, so
 * counting it as eligible would publish a transcript with a hole in it.
 */
export function isPublishable(counts: {
  spanCount: number;
  doneSpanCount: number;
  spansWithRevision: number;
}): boolean {
  return (
    counts.spanCount > 0 &&
    counts.doneSpanCount === counts.spanCount &&
    counts.spansWithRevision === counts.spanCount
  );
}

/**
 * Re-derive every span's state from its decisions.
 *
 * Publication asks this again at the moment it starts. Nothing is trusted from
 * the page the publisher was looking at, and a publisher cannot override a
 * span that is unfinished or disputed — there is no adjudication in v1.
 */
export function evaluateSpanSummaries(spans: readonly SpanSummaryRow[]): WorkspaceEvaluation {
  const manifest: ManifestEntry[] = [];
  let doneSpanCount = 0;
  let blockedSpanCount = 0;
  let unreviewedSpanCount = 0;
  let awaitingSecondApprovalCount = 0;
  let durationSeconds = 0;

  for (const span of spans) {
    switch (span.summary.state) {
      case "done":
        doneSpanCount += 1;
        break;
      case "needs_attention":
        blockedSpanCount += 1;
        break;
      case "needs_second_approval":
        awaitingSecondApprovalCount += 1;
        break;
      default:
        unreviewedSpanCount += 1;
    }

    durationSeconds += Math.max(0, span.endSeconds - span.startSeconds);

    if (span.currentRevision) {
      manifest.push({
        spanId: span.id,
        revisionId: span.currentRevision.id,
        ordinal: span.ordinal,
        startSeconds: span.startSeconds,
        endSeconds: span.endSeconds,
        text: span.currentRevision.text,
      });
    }
  }

  return {
    eligible: isPublishable({
      spanCount: spans.length,
      doneSpanCount,
      spansWithRevision: manifest.length,
    }),
    spanCount: spans.length,
    doneSpanCount,
    blockedSpanCount,
    unreviewedSpanCount,
    awaitingSecondApprovalCount,
    manifest,
    durationSeconds,
  };
}

export async function evaluateWorkspace(
  workspaceId: string,
  client?: Prisma.TransactionClient
): Promise<WorkspaceEvaluation> {
  return evaluateSpanSummaries(await loadSpanSummaries(workspaceId, { client }));
}

export function eligibilityOf(evaluation: WorkspaceEvaluation): PublicationEligibility {
  return {
    eligible: evaluation.eligible,
    spanCount: evaluation.spanCount,
    doneSpanCount: evaluation.doneSpanCount,
    blockedSpanCount: evaluation.blockedSpanCount,
    unreviewedSpanCount: evaluation.unreviewedSpanCount,
    awaitingSecondApprovalCount: evaluation.awaitingSecondApprovalCount,
  };
}

/** The same rule over a workspace's counts, for pages that only need the verdict. */
export function eligibilityOfAggregate(aggregate: WorkspaceAggregate | undefined): PublicationEligibility {
  if (!aggregate) {
    return {
      eligible: false,
      spanCount: 0,
      doneSpanCount: 0,
      blockedSpanCount: 0,
      unreviewedSpanCount: 0,
      awaitingSecondApprovalCount: 0,
    };
  }

  return {
    eligible: isPublishable({
      spanCount: aggregate.spanCount,
      doneSpanCount: aggregate.counts.done,
      spansWithRevision: aggregate.spanCount - aggregate.spansWithoutRevision,
    }),
    spanCount: aggregate.spanCount,
    doneSpanCount: aggregate.counts.done,
    blockedSpanCount: aggregate.counts.needs_attention,
    unreviewedSpanCount: aggregate.counts.not_reviewed,
    awaitingSecondApprovalCount: aggregate.counts.needs_second_approval,
  };
}

export async function getPublicationEligibility(workspaceId: string): Promise<PublicationEligibility> {
  return eligibilityOf(await evaluateWorkspace(workspaceId));
}
