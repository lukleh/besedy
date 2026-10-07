import { Prisma, type TranscriptPublicationStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { loadActorNames } from "@/lib/correction/actor-names";
import { IN_FLIGHT_PUBLICATION_STATUSES } from "@/lib/correction/publication-service";
import { loadWorkspaceAggregates, type WorkspaceAggregate } from "@/lib/correction/span-queries";
import type { SpanState } from "@/lib/correction/span-state";
import {
  deriveOverviewStatus,
  OVERVIEW_STATUSES,
  type OverviewStatus,
} from "@/lib/correction/overview-status";

export { OVERVIEW_STATUSES, deriveOverviewStatus, type OverviewStatus };

/**
 * The catalog-wide view of correction: which recordings are being corrected,
 * how far each has got, which want this person, and which a curator can
 * publish. It stores nothing. Every figure is read from the same reduced span
 * states as the working surface, so the two cannot disagree.
 */

export interface OverviewRecording {
  audioHash: string;
  title: string | null;
  eventId: number | null;
  eventTitle: string | null;
  locationName: string | null;
  dateYear: number | null;
  dateMonth: number | null;
  dateDay: number | null;
  durationSeconds: number;
}

export interface OverviewProgress {
  spanCount: number;
  totalSeconds: number;
  counts: Record<SpanState, number>;
  seconds: Record<SpanState, number>;
}

export interface OverviewItem {
  status: OverviewStatus;
  recording: OverviewRecording;
  workspaceId: string | null;
  progress: OverviewProgress | null;
  /** This person's share of the work; null before the workspace exists */
  mine: WorkspaceAggregate["mine"] | null;
  /** This person has acted in the workspace at some point */
  touchedByMe: boolean;
  lastActivity: { at: Date; actorName: string | null } | null;
  myLastActivityAt: Date | null;
  /** Every span is done: the transcript can be published or republished */
  eligible: boolean;
  /** Spans edited since the snapshot readers see */
  changedSinceReaderPublication: number;
  publication: {
    inFlight: {
      status: TranscriptPublicationStatus;
      error: { code: string; message: string } | null;
    } | null;
  } | null;
}

export interface OverviewSummary {
  byStatus: Record<OverviewStatus, { count: number; seconds: number }>;
}

export interface CorrectionOverview {
  summary: OverviewSummary;
  /** Every live workspace, most recently active first */
  workspaces: OverviewItem[];
  notStarted: { total: number; items: OverviewItem[] };
}

/** More than the corpus holds in primary recordings; a bound, not a page size. */
const NOT_STARTED_LIMIT = 500;

/** What an actor who may not see unreleased material is limited to. */
function visibleSql(canSeeUnreleased: boolean): Prisma.Sql {
  return canSeeUnreleased
    ? Prisma.sql`TRUE`
    : Prisma.sql`(ce.is_actionable AND ce.is_published)`;
}

/** `HH:MM:SS` in seconds; a value that is not that shape counts as unknown. */
const DURATION_SECONDS_SQL = Prisma.sql`
  CASE WHEN ce.duration_hms ~ '^[0-9]+:[0-9]{2}:[0-9]{2}$'
    THEN split_part(ce.duration_hms, ':', 1)::int * 3600
       + split_part(ce.duration_hms, ':', 2)::int * 60
       + split_part(ce.duration_hms, ':', 3)::int
    ELSE 0
  END
`;

const RECORDING_COLUMNS_SQL = Prisma.sql`
  ce.audio_hash AS "audioHash",
  COALESCE(am.title, ce.source_title, ce.filename) AS "title",
  ev.id AS "eventId",
  ev.title AS "eventTitle",
  loc.name AS "locationName",
  ev.date_year AS "dateYear",
  ev.date_month AS "dateMonth",
  ev.date_day AS "dateDay",
  ${DURATION_SECONDS_SQL} AS "durationSeconds"
`;

const RECORDING_JOINS_SQL = Prisma.sql`
  LEFT JOIN audio_metadata am
    ON am.workflow_group_id = ce.workflow_group_id AND am.audio_hash = ce.audio_hash
  LEFT JOIN catalog_event_recording cer
    ON cer.workflow_group_id = ce.workflow_group_id AND cer.audio_hash = ce.audio_hash
  LEFT JOIN catalog_event ev
    ON ev.id = cer.event_id AND ev.workflow_group_id = cer.workflow_group_id
  LEFT JOIN locations loc
    ON loc.id = ev.location_id
`;

interface RawRecording {
  audioHash: string;
  title: string | null;
  eventId: number | null;
  eventTitle: string | null;
  locationName: string | null;
  dateYear: number | null;
  dateMonth: number | null;
  dateDay: number | null;
  durationSeconds: number | bigint;
}

function toRecording(row: RawRecording): OverviewRecording {
  return {
    audioHash: row.audioHash,
    title: row.title,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    locationName: row.locationName,
    dateYear: row.dateYear,
    dateMonth: row.dateMonth,
    dateDay: row.dateDay,
    durationSeconds: Number(row.durationSeconds),
  };
}

interface RawWorkspace extends RawRecording {
  workspaceId: string;
  readerPublicationId: string | null;
  spanDurationSeconds: number;
}

interface RawActivity {
  workspaceId: string;
  lastActorKey: string;
  lastAt: Date;
  myLastAt: Date | null;
}

export interface OverviewInput {
  catalogId: string;
  actorKey: string;
  canSeeUnreleased: boolean;
}

export async function loadCorrectionOverview(input: OverviewInput): Promise<CorrectionOverview> {
  const { catalogId, actorKey } = input;
  const visible = visibleSql(input.canSeeUnreleased);

  const [workspaceRows, notStartedRows] = await Promise.all([
    prisma.$queryRaw<RawWorkspace[]>(Prisma.sql`
      SELECT w.id AS "workspaceId",
             w.reader_publication_id AS "readerPublicationId",
             w.span_duration_seconds AS "spanDurationSeconds",
             ${RECORDING_COLUMNS_SQL}
      FROM transcript_workspace w
      JOIN catalog_entry ce
        ON ce.workflow_group_id = w.workflow_group_id AND ce.audio_hash = w.audio_hash
      ${RECORDING_JOINS_SQL}
      WHERE w.workflow_group_id = ${catalogId}
        AND w.status = 'ACTIVE'
        AND ${visible}
    `),
    prisma.$queryRaw<Array<RawRecording & { total: bigint; totalSeconds: number | bigint }>>(Prisma.sql`
      SELECT ${RECORDING_COLUMNS_SQL},
             count(*) OVER () AS total,
             sum(${DURATION_SECONDS_SQL}) OVER () AS "totalSeconds"
      FROM catalog_event_recording pr
      JOIN catalog_entry ce
        ON ce.workflow_group_id = pr.workflow_group_id AND ce.audio_hash = pr.audio_hash
      ${RECORDING_JOINS_SQL}
      WHERE pr.workflow_group_id = ${catalogId}
        AND pr.is_primary
        AND ce.is_actionable
        AND ${visible}
        AND NOT EXISTS (
          SELECT 1 FROM transcript_workspace w
          WHERE w.workflow_group_id = pr.workflow_group_id
            AND w.audio_hash = pr.audio_hash
            AND w.status = 'ACTIVE'
        )
      ORDER BY ev.date_year DESC NULLS LAST,
               ev.date_month DESC NULLS LAST,
               ev.date_day DESC NULLS LAST,
               ce.audio_hash
      LIMIT ${NOT_STARTED_LIMIT}::int
    `),
  ]);

  const workspaceIds = workspaceRows.map((row) => row.workspaceId);
  const [aggregates, activityRows, changedRows, inFlight] = await Promise.all([
    loadWorkspaceAggregates(workspaceIds, actorKey),
    loadActivity(workspaceIds, actorKey),
    loadChangedSinceReaderPublication(workspaceIds),
    workspaceIds.length === 0
      ? Promise.resolve([])
      : prisma.transcriptPublication.findMany({
          where: { workspaceId: { in: workspaceIds }, status: { in: IN_FLIGHT_PUBLICATION_STATUSES } },
          select: { workspaceId: true, status: true, errorCode: true, errorMessage: true },
        }),
  ]);

  const names = await loadActorNames(activityRows.map((row) => row.lastActorKey));
  const activityByWorkspace = new Map(activityRows.map((row) => [row.workspaceId, row]));
  const inFlightByWorkspace = new Map(inFlight.map((row) => [row.workspaceId, row]));

  const workspaces: OverviewItem[] = workspaceRows.map((row) => {
    const aggregate = aggregates.get(row.workspaceId);
    const activity = activityByWorkspace.get(row.workspaceId);
    const flight = inFlightByWorkspace.get(row.workspaceId);
    const changed = changedRows.get(row.workspaceId) ?? 0;
    const eligible =
      !!aggregate &&
      aggregate.spanCount > 0 &&
      aggregate.counts.done === aggregate.spanCount &&
      aggregate.spansWithoutRevision === 0;

    return {
      status: deriveOverviewStatus({
        eligible,
        readerPublished: row.readerPublicationId !== null,
        inFlight: flight !== undefined,
        changedSinceReaderPublication: changed,
      }),
      recording: toRecording({
        ...row,
        // The workspace froze its own span timing; it is the honest length of
        // the work, and the catalog row may be missing a duration.
        durationSeconds: row.spanDurationSeconds || row.durationSeconds,
      }),
      workspaceId: row.workspaceId,
      progress: aggregate
        ? {
            spanCount: aggregate.spanCount,
            totalSeconds: aggregate.totalSeconds,
            counts: aggregate.counts,
            seconds: aggregate.seconds,
          }
        : null,
      mine: aggregate?.mine ?? null,
      touchedByMe: activity?.myLastAt != null,
      lastActivity: activity
        ? { at: activity.lastAt, actorName: names.get(activity.lastActorKey) ?? null }
        : null,
      myLastActivityAt: activity?.myLastAt ?? null,
      eligible,
      changedSinceReaderPublication: changed,
      publication: {
        inFlight: flight
          ? {
              status: flight.status,
              error: flight.errorCode
                ? { code: flight.errorCode, message: flight.errorMessage ?? "" }
                : null,
            }
          : null,
      },
    };
  });

  workspaces.sort(
    (a, b) => (b.lastActivity?.at.getTime() ?? 0) - (a.lastActivity?.at.getTime() ?? 0)
  );

  const notStarted: OverviewItem[] = notStartedRows.map((row) => ({
    status: "not_started",
    recording: toRecording(row),
    workspaceId: null,
    progress: null,
    mine: null,
    touchedByMe: false,
    lastActivity: null,
    myLastActivityAt: null,
    eligible: false,
    changedSinceReaderPublication: 0,
    publication: null,
  }));

  const summary: OverviewSummary = {
    byStatus: Object.fromEntries(
      OVERVIEW_STATUSES.map((status) => [status, { count: 0, seconds: 0 }])
    ) as OverviewSummary["byStatus"],
  };
  for (const item of workspaces) {
    summary.byStatus[item.status].count += 1;
    summary.byStatus[item.status].seconds += item.recording.durationSeconds;
  }
  // The list of recordings nobody started is capped, the total is not: the
  // summary describes all of them.
  if (notStartedRows.length > 0) {
    summary.byStatus.not_started = {
      count: Number(notStartedRows[0].total),
      seconds: Number(notStartedRows[0].totalSeconds),
    };
  }

  return {
    summary,
    workspaces,
    notStarted: {
      total: notStartedRows.length > 0 ? Number(notStartedRows[0].total) : 0,
      items: notStarted,
    },
  };
}

/** Last action in each workspace, and the last by this person. */
async function loadActivity(workspaceIds: readonly string[], actorKey: string): Promise<RawActivity[]> {
  if (workspaceIds.length === 0) return [];
  const ids = [...workspaceIds];

  return prisma.$queryRaw<RawActivity[]>(Prisma.sql`
    WITH events AS (
      SELECT workspace_id, actor_key, created_at AS at
      FROM transcript_span_revision
      WHERE workspace_id = ANY(${ids}::uuid[]) AND actor_key IS NOT NULL
      UNION ALL
      SELECT workspace_id, actor_key, created_at
      FROM transcript_span_decision
      WHERE workspace_id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT workspace_id, actor_key, created_at
      FROM transcript_span_comment
      WHERE workspace_id = ANY(${ids}::uuid[])
    ),
    latest AS (
      SELECT DISTINCT ON (workspace_id) workspace_id, actor_key, at
      FROM events
      ORDER BY workspace_id, at DESC
    ),
    mine AS (
      SELECT workspace_id, max(at) AS at
      FROM events
      WHERE actor_key = ${actorKey}
      GROUP BY workspace_id
    )
    SELECT latest.workspace_id AS "workspaceId",
           latest.actor_key AS "lastActorKey",
           latest.at AS "lastAt",
           mine.at AS "myLastAt"
    FROM latest
    LEFT JOIN mine ON mine.workspace_id = latest.workspace_id
  `);
}

/**
 * Spans whose live text differs from the snapshot readers see. A revision is
 * immutable, so a different revision id is a different text, even when an edit
 * later returns to the same words.
 */
async function loadChangedSinceReaderPublication(
  workspaceIds: readonly string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (workspaceIds.length === 0) return result;

  const rows = await prisma.$queryRaw<Array<{ workspaceId: string; changed: bigint }>>(Prisma.sql`
    SELECT w.id AS "workspaceId", count(*) AS changed
    FROM transcript_workspace w
    JOIN transcript_span s ON s.workspace_id = w.id
    WHERE w.id = ANY(${[...workspaceIds]}::uuid[])
      AND w.reader_publication_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transcript_publication_span ps
        WHERE ps.publication_id = w.reader_publication_id
          AND ps.span_id = s.id
          AND ps.revision_id = s.current_revision_id
      )
    GROUP BY w.id
  `);
  for (const row of rows) result.set(row.workspaceId, Number(row.changed));
  return result;
}
