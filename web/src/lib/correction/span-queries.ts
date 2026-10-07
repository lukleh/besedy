import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { spanStatesSql } from "@/lib/correction/span-state-sql";
import type { SpanState } from "@/lib/correction/span-state";

/**
 * Counts and positions read straight from the reduced span states.
 *
 * Everything here sits on `spanStatesSql`, the single derivation of what makes
 * a span done, so the overview, the page header, the segment list, the strip
 * and the publication check cannot disagree about it.
 */

export const SPAN_FILTERS = [
  "all",
  "mine_open",
  "needs_attention",
  "needs_second_approval",
  "not_reviewed",
] as const;

/**
 * Which spans the segment list shows.
 *
 * `mine_open` is what still wants this person: the span is not done and they
 * have not approved it. One they objected to still counts, because it is
 * theirs to withdraw or have addressed. It is the same set the resume position
 * and "next to resolve" walk.
 */
export type SpanFilter = (typeof SPAN_FILTERS)[number];

function filterSql(filter: SpanFilter, actorKey: string): Prisma.Sql {
  switch (filter) {
    case "mine_open":
      return Prisma.sql`state <> 'done' AND NOT (${actorKey}::text = ANY(approver_ids))`;
    case "needs_attention":
    case "needs_second_approval":
    case "not_reviewed":
      return Prisma.sql`state = ${filter}`;
    default:
      return Prisma.sql`TRUE`;
  }
}

function workspaceStates(workspaceIds: readonly string[]): Prisma.Sql {
  return spanStatesSql(Prisma.sql`s.workspace_id = ANY(${[...workspaceIds]}::uuid[])`);
}

interface RawAggregate {
  workspaceId: string;
  spanCount: bigint;
  spansWithoutRevision: bigint;
  totalSeconds: number;
  doneCount: bigint;
  doneSeconds: number;
  needsAttentionCount: bigint;
  needsAttentionSeconds: number;
  needsSecondApprovalCount: bigint;
  needsSecondApprovalSeconds: number;
  notReviewedCount: bigint;
  notReviewedSeconds: number;
  myApprovedCount: bigint;
  myDisapprovedCount: bigint;
  myWaitingOnOthersCount: bigint;
  myOpenCount: bigint;
}

export interface WorkspaceAggregate {
  workspaceId: string;
  spanCount: number;
  /** Spans that cannot appear in a publication manifest */
  spansWithoutRevision: number;
  totalSeconds: number;
  counts: Record<SpanState, number>;
  seconds: Record<SpanState, number>;
  mine: {
    /** Spans this person currently approves */
    approved: number;
    /** Spans this person currently objects to */
    disapproved: number;
    /** Spans only this person has approved so far: waiting for a second */
    waitingOnOthers: number;
    /** Spans that still want this person */
    open: number;
  };
}

/** Counts and audio seconds per state for each workspace, in one query. */
export async function loadWorkspaceAggregates(
  workspaceIds: readonly string[],
  actorKey: string | null,
  client: Pick<typeof prisma, "$queryRaw"> = prisma
): Promise<Map<string, WorkspaceAggregate>> {
  const result = new Map<string, WorkspaceAggregate>();
  if (workspaceIds.length === 0) return result;

  const actor = actorKey ?? "";
  const rows = await client.$queryRaw<RawAggregate[]>(Prisma.sql`
    SELECT
      workspace_id AS "workspaceId",
      count(*) AS "spanCount",
      count(*) FILTER (WHERE NOT has_revision) AS "spansWithoutRevision",
      COALESCE(sum(GREATEST(end_seconds - start_seconds, 0)), 0) AS "totalSeconds",
      count(*) FILTER (WHERE state = 'done') AS "doneCount",
      COALESCE(sum(GREATEST(end_seconds - start_seconds, 0)) FILTER (WHERE state = 'done'), 0) AS "doneSeconds",
      count(*) FILTER (WHERE state = 'needs_attention') AS "needsAttentionCount",
      COALESCE(sum(GREATEST(end_seconds - start_seconds, 0)) FILTER (WHERE state = 'needs_attention'), 0) AS "needsAttentionSeconds",
      count(*) FILTER (WHERE state = 'needs_second_approval') AS "needsSecondApprovalCount",
      COALESCE(sum(GREATEST(end_seconds - start_seconds, 0)) FILTER (WHERE state = 'needs_second_approval'), 0) AS "needsSecondApprovalSeconds",
      count(*) FILTER (WHERE state = 'not_reviewed') AS "notReviewedCount",
      COALESCE(sum(GREATEST(end_seconds - start_seconds, 0)) FILTER (WHERE state = 'not_reviewed'), 0) AS "notReviewedSeconds",
      count(*) FILTER (WHERE ${actor}::text = ANY(approver_ids)) AS "myApprovedCount",
      count(*) FILTER (WHERE ${actor}::text = ANY(disapprover_ids)) AS "myDisapprovedCount",
      count(*) FILTER (
        WHERE state = 'needs_second_approval' AND ${actor}::text = ANY(approver_ids)
      ) AS "myWaitingOnOthersCount",
      count(*) FILTER (
        WHERE state <> 'done' AND NOT (${actor}::text = ANY(approver_ids))
      ) AS "myOpenCount"
    FROM (${workspaceStates(workspaceIds)}) states
    GROUP BY workspace_id
  `);

  for (const row of rows) {
    result.set(row.workspaceId, {
      workspaceId: row.workspaceId,
      spanCount: Number(row.spanCount),
      spansWithoutRevision: Number(row.spansWithoutRevision),
      totalSeconds: Number(row.totalSeconds),
      counts: {
        done: Number(row.doneCount),
        needs_attention: Number(row.needsAttentionCount),
        needs_second_approval: Number(row.needsSecondApprovalCount),
        not_reviewed: Number(row.notReviewedCount),
      },
      seconds: {
        done: Number(row.doneSeconds),
        needs_attention: Number(row.needsAttentionSeconds),
        needs_second_approval: Number(row.needsSecondApprovalSeconds),
        not_reviewed: Number(row.notReviewedSeconds),
      },
      mine: {
        approved: Number(row.myApprovedCount),
        disapproved: Number(row.myDisapprovedCount),
        waitingOnOthers: Number(row.myWaitingOnOthersCount),
        open: Number(row.myOpenCount),
      },
    });
  }

  return result;
}

export interface SpanPosition {
  spanId: string;
  ordinal: number;
}

/**
 * The next span that still wants this person, after `afterOrdinal` and
 * wrapping round to the start of the recording.
 *
 * With the default it is where to pick the work up: a three-hour recording
 * runs to several hundred spans and nobody finishes one in a sitting, so
 * opening at the first span every time would make resuming a scrolling
 * exercise. A span others have finished is not their problem, and one they
 * objected to still is.
 */
export async function findNextOpenSpan(
  workspaceId: string,
  actorKey: string,
  afterOrdinal = -1
): Promise<SpanPosition | null> {
  const rows = await prisma.$queryRaw<Array<{ spanId: string; ordinal: number }>>(Prisma.sql`
    SELECT span_id AS "spanId", ordinal
    FROM (${workspaceStates([workspaceId])}) states
    WHERE ${filterSql("mine_open", actorKey)}
    ORDER BY (ordinal <= ${afterOrdinal}::int), ordinal
    LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * One page of the spans a filter selects, in source order, after a cursor.
 *
 * The page is positioned by the ordinal of the last span already shown, not by
 * an offset. What a filter selects changes with every approval, so an offset
 * into it would skip or repeat a span the moment an earlier page was
 * refreshed; an ordinal still names the same place in the recording.
 */
export async function listFilteredSpanIds(
  workspaceId: string,
  actorKey: string,
  filter: SpanFilter,
  options: { afterOrdinal: number; limit: number }
): Promise<{ ids: string[]; hasMore: boolean }> {
  // One row more than asked for says whether another page exists, without a
  // second pass over the workspace to count.
  const rows = await prisma.$queryRaw<Array<{ spanId: string }>>(Prisma.sql`
    SELECT span_id AS "spanId"
    FROM (${workspaceStates([workspaceId])}) states
    WHERE ${filterSql(filter, actorKey)}
      AND ordinal > ${options.afterOrdinal}::int
    ORDER BY ordinal
    LIMIT ${options.limit + 1}::int
  `);

  return {
    ids: rows.slice(0, options.limit).map((row) => row.spanId),
    hasMore: rows.length > options.limit,
  };
}

export interface StripSpan {
  spanId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  state: SpanState;
  /** This person currently approves it */
  approvedByMe: boolean;
  /** This person currently objects to it */
  disapprovedByMe: boolean;
}

/** Every span's position and state, for the strip over the whole recording. */
export async function loadSpanStrip(
  workspaceId: string,
  actorKey: string
): Promise<StripSpan[]> {
  const rows = await prisma.$queryRaw<
    StripSpan[]
  >(Prisma.sql`
    SELECT span_id AS "spanId",
           ordinal,
           start_seconds AS "startSeconds",
           end_seconds AS "endSeconds",
           state,
           (${actorKey}::text = ANY(approver_ids)) AS "approvedByMe",
           (${actorKey}::text = ANY(disapprover_ids)) AS "disapprovedByMe"
    FROM (${workspaceStates([workspaceId])}) states
    ORDER BY ordinal
  `);
  return rows;
}
