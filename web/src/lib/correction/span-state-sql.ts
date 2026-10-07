import { Prisma } from "@/generated/prisma/client";
import { REQUIRED_APPROVALS, type SpanState } from "@/lib/correction/span-state";

/** One span with its decisions reduced, as `spanStatesSql` returns it. */
export interface SpanStateRow {
  span_id: string;
  workspace_id: string;
  ordinal: number;
  start_seconds: number;
  end_seconds: number;
  has_revision: boolean;
  /** Actor keys, sorted */
  approver_ids: string[];
  disapprover_ids: string[];
  state: SpanState;
}

/**
 * The one place a span's state is derived.
 *
 * Returns a SELECT, to be embedded as a subquery or a CTE, with one row per
 * span matched by `scope` (a boolean expression over the alias `s`, a row of
 * `transcript_span`).
 *
 * Each person's latest decision on the span's current revision is their
 * effective decision. Ordering is by the stored write sequence, never by
 * timestamp: timestamps have millisecond precision and can tie, and a tie
 * broken the wrong way would revive an approval the person had withdrawn.
 * Decisions on superseded revisions never count, which is what stops an old
 * approval from reviving when text returns to earlier wording. A withdrawal
 * leaves the person with no effective decision.
 *
 * The state is evaluated in order, so an objection is never outvoted: extra
 * approvals do not carry a span past someone who currently disapproves of it.
 *
 * `revision` names the revision whose decisions count. It defaults to the
 * span's current one; a replayed command asks about the revision it was
 * issued against.
 */
export function spanStatesSql(
  scope: Prisma.Sql,
  revision: Prisma.Sql = Prisma.sql`s.current_revision_id`
): Prisma.Sql {
  const required = Prisma.raw(String(REQUIRED_APPROVALS));
  return Prisma.sql`
    SELECT
      s.id AS span_id,
      s.workspace_id AS workspace_id,
      s.ordinal AS ordinal,
      s.start_seconds AS start_seconds,
      s.end_seconds AS end_seconds,
      (s.current_revision_id IS NOT NULL) AS has_revision,
      COALESCE(
        array_agg(e.actor_key ORDER BY e.actor_key) FILTER (WHERE e.kind = 'APPROVE'),
        ARRAY[]::text[]
      ) AS approver_ids,
      COALESCE(
        array_agg(e.actor_key ORDER BY e.actor_key) FILTER (WHERE e.kind = 'DISAPPROVE'),
        ARRAY[]::text[]
      ) AS disapprover_ids,
      CASE
        WHEN count(*) FILTER (WHERE e.kind = 'DISAPPROVE') > 0 THEN 'needs_attention'
        WHEN count(*) FILTER (WHERE e.kind = 'APPROVE') >= ${required} THEN 'done'
        WHEN count(*) FILTER (WHERE e.kind = 'APPROVE') > 0 THEN 'needs_second_approval'
        ELSE 'not_reviewed'
      END AS state
    FROM transcript_span s
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (d.actor_key) d.actor_key, d.kind
      FROM transcript_span_decision d
      WHERE d.span_id = s.id AND d.revision_id = ${revision}
      ORDER BY d.actor_key, d.sequence DESC
    ) e ON e.kind IN ('APPROVE', 'DISAPPROVE')
    WHERE ${scope}
    GROUP BY s.id
  `;
}
