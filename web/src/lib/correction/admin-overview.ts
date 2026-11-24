import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { loadActorNames } from "@/lib/correction/actor-names";
import {
  activityEventsSql,
  loadCorrectionOverview,
  type CorrectionOverview,
  type OverviewInput,
} from "@/lib/correction/overview";
import { spanStatesSql } from "@/lib/correction/span-state-sql";

/**
 * Correction as the person who looks after it sees it: the corrector's
 * overview of every recording, plus who is working where, whose first pass
 * waits for a second person, and which spans are disputed.
 *
 * Like the overview it extends, it stores nothing and reads span states from
 * the one place they are derived.
 */

export interface AdminPerson {
  name: string | null;
  lastActivityAt: Date;
  /** The recording of this person's latest action */
  lastAudioHash: string;
  /** Audio this person approved or edited in the window, each span once */
  approvedSeconds7d: number;
  approvedSeconds30d: number;
  /** Audio only this person has approved so far */
  waitingSeconds: number;
  /** Spans this person approves that somebody else objects to */
  disputedCount: number;
}

export interface AdminContributor {
  name: string | null;
  lastActivityAt: Date;
  /** Audio in this recording only this person has approved so far */
  waitingSeconds: number;
}

export interface AdminDispute {
  audioHash: string;
  spanId: string;
  startSeconds: number;
  /** When the standing objection was made */
  since: Date | null;
  objectorNames: Array<string | null>;
}

export interface CorrectionAdminOverview extends CorrectionOverview {
  /** Everyone who has acted in a live workspace, most recently active first */
  people: AdminPerson[];
  /** Who has acted in each workspace, most recently active first */
  contributors: Record<string, AdminContributor[]>;
  /** The oldest standing objections; `total` counts all of them */
  disputes: { total: number; items: AdminDispute[] };
}

/** How many disputed spans the page lists; the total is always exact. */
const DISPUTE_LIMIT = 50;

interface RawActorActivity {
  workspaceId: string;
  actorKey: string;
  lastAt: Date;
}

interface RawActorStanding {
  workspaceId: string;
  actorKey: string;
  waitingSeconds: number;
  disputedCount: bigint;
}

interface RawActorPace {
  actorKey: string;
  seconds7d: number;
  seconds30d: number;
}

interface RawDispute {
  workspaceId: string;
  spanId: string;
  startSeconds: number;
  objectorKeys: string[];
  since: Date | null;
}

export async function loadCorrectionAdminOverview(
  input: OverviewInput
): Promise<CorrectionAdminOverview> {
  const overview = await loadCorrectionOverview(input);

  const audioHashByWorkspace = new Map<string, string>();
  for (const item of overview.workspaces) {
    if (item.workspaceId) audioHashByWorkspace.set(item.workspaceId, item.recording.audioHash);
  }
  const ids = [...audioHashByWorkspace.keys()];
  if (ids.length === 0) {
    return { ...overview, people: [], contributors: {}, disputes: { total: 0, items: [] } };
  }

  const states = spanStatesSql(Prisma.sql`s.workspace_id = ANY(${ids}::uuid[])`);

  const [activity, standing, pace, disputes] = await Promise.all([
    prisma.$queryRaw<RawActorActivity[]>(Prisma.sql`
      SELECT workspace_id AS "workspaceId", actor_key AS "actorKey", max(at) AS "lastAt"
      FROM (${activityEventsSql(ids)}) events
      GROUP BY workspace_id, actor_key
      ORDER BY max(at) DESC
    `),
    // An edit stores an approval too, so the approvers of a span include
    // whoever wrote its current text.
    prisma.$queryRaw<RawActorStanding[]>(Prisma.sql`
      SELECT states.workspace_id AS "workspaceId",
             approver AS "actorKey",
             COALESCE(sum(GREATEST(states.end_seconds - states.start_seconds, 0))
               FILTER (WHERE states.state = 'needs_second_approval'), 0) AS "waitingSeconds",
             count(*) FILTER (WHERE states.state = 'needs_attention') AS "disputedCount"
      FROM (${states}) states, unnest(states.approver_ids) AS approver
      WHERE states.state IN ('needs_second_approval', 'needs_attention')
      GROUP BY states.workspace_id, approver
    `),
    // Each span counts once per person however often they returned to it; a
    // span whose latest approval falls in the last week counts for both windows.
    prisma.$queryRaw<RawActorPace[]>(Prisma.sql`
      SELECT actor_key AS "actorKey",
             COALESCE(sum(seconds) FILTER (WHERE at >= now() - interval '7 days'), 0) AS "seconds7d",
             COALESCE(sum(seconds), 0) AS "seconds30d"
      FROM (
        SELECT d.actor_key,
               max(d.created_at) AS at,
               GREATEST(s.end_seconds - s.start_seconds, 0) AS seconds
        FROM transcript_span_decision d
        JOIN transcript_span s ON s.id = d.span_id
        WHERE d.workspace_id = ANY(${ids}::uuid[])
          AND d.kind = 'APPROVE'
          AND d.created_at >= now() - interval '30 days'
        GROUP BY d.actor_key, s.id
      ) recent
      GROUP BY actor_key
    `),
    prisma.$queryRaw<RawDispute[]>(Prisma.sql`
      SELECT states.workspace_id AS "workspaceId",
             states.span_id AS "spanId",
             states.start_seconds AS "startSeconds",
             states.disapprover_ids AS "objectorKeys",
             (
               SELECT min(d.created_at)
               FROM transcript_span_decision d
               JOIN transcript_span sp ON sp.id = d.span_id
               WHERE d.span_id = states.span_id
                 AND d.revision_id = sp.current_revision_id
                 AND d.kind = 'DISAPPROVE'
                 AND d.actor_key = ANY(states.disapprover_ids)
             ) AS since
      FROM (${states}) states
      WHERE states.state = 'needs_attention'
      ORDER BY since ASC NULLS LAST, states.span_id
      LIMIT ${DISPUTE_LIMIT}::int
    `),
  ]);

  const names = await loadActorNames([
    ...activity.map((row) => row.actorKey),
    ...disputes.flatMap((row) => row.objectorKeys),
  ]);

  const standingOf = (workspaceId: string, actorKey: string) =>
    standing.find((row) => row.workspaceId === workspaceId && row.actorKey === actorKey);
  const paceByActor = new Map(pace.map((row) => [row.actorKey, row]));

  const contributors: Record<string, AdminContributor[]> = {};
  const people = new Map<string, AdminPerson>();
  // Rows arrive most recent first, so the first row of an actor is their
  // latest action and each workspace's list is already in order.
  for (const row of activity) {
    const mine = standingOf(row.workspaceId, row.actorKey);
    const waitingSeconds = Number(mine?.waitingSeconds ?? 0);
    const name = names.get(row.actorKey) ?? null;

    (contributors[row.workspaceId] ??= []).push({ name, lastActivityAt: row.lastAt, waitingSeconds });

    const person = people.get(row.actorKey);
    if (person) {
      person.waitingSeconds += waitingSeconds;
      person.disputedCount += Number(mine?.disputedCount ?? 0);
      continue;
    }
    const recent = paceByActor.get(row.actorKey);
    people.set(row.actorKey, {
      name,
      lastActivityAt: row.lastAt,
      lastAudioHash: audioHashByWorkspace.get(row.workspaceId) ?? "",
      approvedSeconds7d: Number(recent?.seconds7d ?? 0),
      approvedSeconds30d: Number(recent?.seconds30d ?? 0),
      waitingSeconds,
      disputedCount: Number(mine?.disputedCount ?? 0),
    });
  }

  return {
    ...overview,
    people: [...people.values()],
    contributors,
    disputes: {
      total: overview.workspaces.reduce(
        (sum, item) => sum + (item.progress?.counts.needs_attention ?? 0),
        0
      ),
      items: disputes.map((row) => ({
        audioHash: audioHashByWorkspace.get(row.workspaceId) ?? "",
        spanId: row.spanId,
        startSeconds: row.startSeconds,
        since: row.since,
        objectorNames: row.objectorKeys.map((key) => names.get(key) ?? null),
      })),
    },
  };
}
