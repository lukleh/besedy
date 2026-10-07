import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import type { SpanDecisionSummary, SpanState } from "@/lib/correction/span-state";
import { spanStatesSql } from "@/lib/correction/span-state-sql";

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

interface SpanDecisionRow {
  spanId: string;
  approverIds: string[];
  disapproverIds: string[];
  state: SpanState;
}

/**
 * Reduce the decisions of the given spans, in one query.
 *
 * The reduction is `spanStatesSql`, shared with every count and listing, so
 * there is exactly one statement of what makes a span done. `revisionId`
 * overrides the revision whose decisions count and is meaningful for a single
 * span only.
 */
export async function loadSpanDecisionSummaries(
  spanIds: readonly string[],
  options: { client?: Prisma.TransactionClient; revisionId?: string } = {}
): Promise<Map<string, SpanDecisionSummary>> {
  const result = new Map<string, SpanDecisionSummary>();
  if (spanIds.length === 0) return result;

  const client = options.client ?? prisma;
  const revision = options.revisionId
    ? Prisma.sql`${options.revisionId}::uuid`
    : undefined;
  const rows = await client.$queryRaw<SpanDecisionRow[]>(Prisma.sql`
    SELECT span_id AS "spanId",
           approver_ids AS "approverIds",
           disapprover_ids AS "disapproverIds",
           state
    FROM (${spanStatesSql(Prisma.sql`s.id = ANY(${[...spanIds]}::uuid[])`, revision)}) states
  `);

  for (const row of rows) {
    result.set(row.spanId, {
      approverIds: row.approverIds,
      disapproverIds: row.disapproverIds,
      state: row.state,
      isDone: row.state === "done",
    });
  }
  return result;
}

const NO_DECISIONS: SpanDecisionSummary = {
  approverIds: [],
  disapproverIds: [],
  state: "not_reviewed",
  isDone: false,
};

/**
 * Load every span of a workspace with its derived state, in one pass.
 *
 * Listing, the publication check and the page all read the same two queries,
 * the spans and then their reduced decisions, so they share this loader rather
 * than each scanning a multi-hour workspace on their own. Only decisions on
 * the current revision count, which is what keeps a superseded approval from
 * leaking in.
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

  const summaries = await loadSpanDecisionSummaries(
    spans.map((span) => span.id),
    { client }
  );

  return spans.map((span) => ({
    id: span.id,
    ordinal: span.ordinal,
    startSeconds: span.startSeconds,
    endSeconds: span.endSeconds,
    originalText: span.originalText,
    currentRevision: span.currentRevision,
    summary: summaries.get(span.id) ?? NO_DECISIONS,
  }));
}
