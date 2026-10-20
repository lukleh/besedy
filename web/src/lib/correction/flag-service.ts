import {
  Prisma,
  type TranscriptSpanFlagAction,
  type TranscriptSpanFlagKind,
} from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireContributorConsent } from "@/lib/correction/consent";
import { CorrectionError } from "@/lib/correction/errors";
import { lockWorkspace } from "@/lib/correction/workspace-lock";

/**
 * Flags say something about a span's audio (ADR 0012): unclear speech,
 * overlapping speakers, another language, music or noise, a word cut at the
 * boundary, or simply "keep this out of training". They never affect the done
 * state or publication; training export leaves flagged chunks out.
 *
 * Every set and clear is an immutable event. A span's current flags are
 * derived from its latest event per kind, the way span state is derived from
 * decisions, so there is no status column that could drift.
 */

export interface SpanFlag {
  kind: TranscriptSpanFlagKind;
  languageCode: string | null;
  comment: string | null;
  actorKey: string;
  setAt: Date;
}

export interface FlagCommand {
  workspaceId: string;
  spanId: string;
  userId: string;
  kind: TranscriptSpanFlagKind;
  action: TranscriptSpanFlagAction;
  languageCode?: string | null;
  comment?: string | null;
  idempotencyKey?: string | null;
}

interface CurrentFlagRow {
  span_id: string;
  kind: TranscriptSpanFlagKind;
  action: TranscriptSpanFlagAction;
  language_code: string | null;
  comment: string | null;
  actor_key: string;
  created_at: Date;
}

/** Current flags of the given spans, keyed by span id. */
export async function loadSpanFlags(
  spanIds: readonly string[],
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Map<string, SpanFlag[]>> {
  const result = new Map<string, SpanFlag[]>();
  if (spanIds.length === 0) return result;
  const rows = await client.$queryRaw<CurrentFlagRow[]>`
    SELECT DISTINCT ON (span_id, kind)
      span_id, kind, action, language_code, comment, actor_key, created_at
    FROM transcript_span_flag_event
    WHERE span_id = ANY(${[...spanIds]}::uuid[])
    ORDER BY span_id, kind, sequence DESC
  `;
  for (const row of rows) {
    if (row.action !== "SET") continue;
    const flags = result.get(row.span_id) ?? [];
    flags.push({
      kind: row.kind,
      languageCode: row.language_code,
      comment: row.comment,
      actorKey: row.actor_key,
      setAt: row.created_at,
    });
    result.set(row.span_id, flags);
  }
  return result;
}

/**
 * Set or clear one flag. Setting a flag that is already set with the same
 * language, or clearing one that is not set, records nothing: the history
 * holds changes, not repetitions. A retried request with the same key replays.
 */
export async function recordFlag(command: FlagCommand): Promise<{ flags: SpanFlag[]; replayed: boolean }> {
  const languageCode = command.kind === "OTHER_LANGUAGE" ? (command.languageCode ?? null) : null;
  if (command.kind === "OTHER_LANGUAGE" && command.action === "SET" && !languageCode) {
    throw new CorrectionError("INVALID_FLAG", "Name the language with its ISO 639-1 code");
  }
  if (command.kind !== "OTHER_LANGUAGE" && command.languageCode) {
    throw new CorrectionError("INVALID_FLAG", "Only the other-language flag takes a language code");
  }
  const comment = command.comment?.trim() || null;

  return prisma.$transaction(async (tx) => {
    // A flag changes nothing a publication snapshots, so, like a comment, it
    // is accepted while one is in flight; an archived workspace takes none.
    await lockWorkspace(tx, command.workspaceId);

    if (command.idempotencyKey) {
      const previous = await tx.transcriptSpanFlagEvent.findUnique({
        where: {
          workspaceId_actorKey_idempotencyKey: {
            workspaceId: command.workspaceId,
            actorKey: command.userId,
            idempotencyKey: command.idempotencyKey,
          },
        },
        select: { spanId: true, kind: true, action: true, languageCode: true },
      });
      if (previous) {
        if (
          previous.spanId !== command.spanId ||
          previous.kind !== command.kind ||
          previous.action !== command.action ||
          previous.languageCode !== languageCode
        ) {
          throw new CorrectionError("IDEMPOTENCY_CONFLICT", "That idempotency key was used for a different flag");
        }
        return { flags: (await loadSpanFlags([command.spanId], tx)).get(command.spanId) ?? [], replayed: true };
      }
    }

    const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: command.workspaceId },
      select: { status: true },
    });
    if (workspace.status === "ARCHIVED") {
      throw new CorrectionError("WORKSPACE_ARCHIVED", "This correction workspace has been archived");
    }
    await requireContributorConsent(tx, command.userId);

    const span = await tx.transcriptSpan.findUnique({
      where: { id: command.spanId },
      select: { workspaceId: true },
    });
    if (!span || span.workspaceId !== command.workspaceId) {
      throw new CorrectionError("SPAN_NOT_FOUND", "Span not found in this workspace");
    }

    const current = (await loadSpanFlags([command.spanId], tx)).get(command.spanId) ?? [];
    const existing = current.find((flag) => flag.kind === command.kind);
    const unchanged =
      command.action === "CLEAR"
        ? !existing
        : existing !== undefined && existing.languageCode === languageCode && existing.comment === comment;

    if (!unchanged) {
      await tx.transcriptSpanFlagEvent.create({
        data: {
          workspaceId: command.workspaceId,
          spanId: command.spanId,
          kind: command.kind,
          action: command.action,
          languageCode: command.action === "SET" ? languageCode : null,
          comment: command.action === "SET" ? comment : null,
          actorKey: command.userId,
          userId: command.userId,
          idempotencyKey: command.idempotencyKey ?? null,
        },
      });
    }

    return { flags: (await loadSpanFlags([command.spanId], tx)).get(command.spanId) ?? [], replayed: false };
  });
}
