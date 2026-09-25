import type { Prisma } from "@/generated/prisma/client";
import { loadSpanSummaries, type SpanSummaryRow } from "@/lib/correction/span-summaries";

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
    // Every span must be done *and* carry a revision to publish. A span
    // without a current revision cannot appear in a manifest, so counting it
    // as eligible would publish a transcript with a hole in it.
    eligible: spans.length > 0 && doneSpanCount === spans.length && manifest.length === spans.length,
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

export async function getPublicationEligibility(workspaceId: string): Promise<PublicationEligibility> {
  return eligibilityOf(await evaluateWorkspace(workspaceId));
}
