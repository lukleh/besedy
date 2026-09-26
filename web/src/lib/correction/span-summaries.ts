import { Prisma, type TranscriptDecisionKind } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { summarizeSpanDecisions, type SpanDecisionSummary } from "@/lib/correction/span-state";

/** One span with the decisions on its current revision already reduced. */
export interface SpanSummaryRow {
  id: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  originalText: string;
  currentRevision: {
    id: string;
    text: string;
    actorKey: string | null;
    createdAt: Date;
    previousRevisionId: string | null;
  } | null;
  summary: SpanDecisionSummary;
}

interface DecisionRow {
  spanId: string;
  actorKey: string;
  kind: TranscriptDecisionKind;
  createdAt: Date;
}

/**
 * Load every span of a workspace with its derived state, in one pass.
 *
 * Progress, the resume position, the publication check and the page listing
 * all reduce the same two queries — the spans, then the decisions bound to
 * their current revisions — so they share this loader rather than each
 * scanning a multi-hour workspace on their own. Only decisions on the current
 * revision are loaded, which is what keeps a superseded approval from
 * counting.
 */
export async function loadSpanSummaries(
  workspaceId: string,
  options: { offset?: number; limit?: number; client?: Prisma.TransactionClient } = {}
): Promise<SpanSummaryRow[]> {
  const client = options.client ?? prisma;
  const spans = await client.transcriptSpan.findMany({
    where: { workspaceId },
    orderBy: { ordinal: "asc" },
    skip: options.offset,
    take: options.limit,
    select: {
      id: true,
      ordinal: true,
      startSeconds: true,
      endSeconds: true,
      originalText: true,
      currentRevisionId: true,
      currentRevision: {
        select: {
          id: true,
          text: true,
          actorKey: true,
          createdAt: true,
          previousRevisionId: true,
        },
      },
    },
  });

  const revisionIds = spans
    .map((span) => span.currentRevisionId)
    .filter((id): id is string => id !== null);

  const decisions: DecisionRow[] =
    revisionIds.length === 0
      ? []
      : await client.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: { spanId: true, actorKey: true, kind: true, createdAt: true },
          orderBy: { sequence: "asc" },
        });

  const decisionsBySpan = new Map<string, DecisionRow[]>();
  for (const decision of decisions) {
    const bucket = decisionsBySpan.get(decision.spanId);
    if (bucket) bucket.push(decision);
    else decisionsBySpan.set(decision.spanId, [decision]);
  }

  return spans.map((span) => ({
    id: span.id,
    ordinal: span.ordinal,
    startSeconds: span.startSeconds,
    endSeconds: span.endSeconds,
    originalText: span.originalText,
    currentRevision: span.currentRevision,
    summary: summarizeSpanDecisions(decisionsBySpan.get(span.id) ?? []),
  }));
}
