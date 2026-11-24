import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { loadActorNames } from "@/lib/correction/actor-names";
import { PRESENCE_WINDOW_SECONDS } from "@/lib/correction/presence-window";

/**
 * Who has a workspace open right now, and on which span.
 *
 * Presence only helps people stay out of each other's way (ADR 0006): no
 * write checks it and the revision check stays the one guarantee. Nothing
 * cleans it on a schedule; readers ignore rows older than the presence
 * window.
 */

/** Rows this old are removed by the next heartbeat in their workspace. */
const STALE_AFTER = Prisma.sql`interval '1 day'`;
const WINDOW = Prisma.sql`make_interval(secs => ${PRESENCE_WINDOW_SECONDS})`;
/** The columns are `timestamp` in UTC, as Prisma writes them. */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

export interface PresentPerson {
  userId: string;
  name: string | null;
  /** The span on their screen; null while their page is still loading */
  spanId: string | null;
  ordinal: number | null;
  startSeconds: number | null;
  /** They have unsaved wording on that span */
  editing: boolean;
}

interface RawPresence {
  workspaceId: string;
  userId: string;
  spanId: string | null;
  ordinal: number | null;
  startSeconds: number | null;
  editing: boolean;
}

/**
 * Record where a person is. A span that is not in this workspace is stored as
 * no span, so a stale page cannot point at another recording.
 */
export async function recordPresence(input: {
  workspaceId: string;
  userId: string;
  spanId: string | null;
  editing: boolean;
}): Promise<void> {
  const { workspaceId, userId, spanId, editing } = input;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO transcript_workspace_presence (workspace_id, user_id, span_id, editing, seen_at)
    SELECT ${workspaceId}::uuid, ${userId}, span.id, ${editing}::boolean AND span.id IS NOT NULL, ${NOW}
    FROM (SELECT 1) one
    LEFT JOIN transcript_span span
      ON span.id = ${spanId}::uuid AND span.workspace_id = ${workspaceId}::uuid
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET span_id = EXCLUDED.span_id, editing = EXCLUDED.editing, seen_at = EXCLUDED.seen_at
  `);
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM transcript_workspace_presence
    WHERE workspace_id = ${workspaceId}::uuid AND seen_at < ${NOW} - ${STALE_AFTER}
  `);
}

/** The person left the page; they disappear at once instead of timing out. */
export async function clearPresence(workspaceId: string, userId: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM transcript_workspace_presence
    WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}
  `);
}

/**
 * Everyone else currently in the given workspaces, by workspace, in the
 * order of the recording. The asking person is left out: they know where
 * they are.
 */
export async function loadPresence(
  workspaceIds: readonly string[],
  exceptUserId: string
): Promise<Map<string, PresentPerson[]>> {
  const result = new Map<string, PresentPerson[]>();
  if (workspaceIds.length === 0) return result;

  const rows = await prisma.$queryRaw<RawPresence[]>(Prisma.sql`
    SELECT presence.workspace_id AS "workspaceId",
           presence.user_id AS "userId",
           presence.span_id AS "spanId",
           span.ordinal AS "ordinal",
           span.start_seconds AS "startSeconds",
           presence.editing AS "editing"
    FROM transcript_workspace_presence presence
    LEFT JOIN transcript_span span ON span.id = presence.span_id
    WHERE presence.workspace_id = ANY(${[...workspaceIds]}::uuid[])
      AND presence.user_id <> ${exceptUserId}
      AND presence.seen_at > ${NOW} - ${WINDOW}
    ORDER BY span.ordinal NULLS LAST, presence.user_id
  `);

  const names = await loadActorNames(rows.map((row) => row.userId));
  for (const { workspaceId, ...row } of rows) {
    const people = result.get(workspaceId) ?? [];
    people.push({ ...row, name: names.get(row.userId) ?? null });
    result.set(workspaceId, people);
  }
  return result;
}
