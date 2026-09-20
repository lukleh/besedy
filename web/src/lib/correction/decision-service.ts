import { randomUUID } from "node:crypto";
import { Prisma, type TranscriptDecisionKind } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";
import {
  hashSpanText,
  isPublishableSpanText,
  normalizeSpanText,
} from "@/lib/correction/text";
import {
  summarizeSpanDecisions,
  type SpanState,
} from "@/lib/correction/span-state";
import { lockWorkspace } from "@/lib/correction/workspace-lock";

export interface SpanCommandResult {
  spanId: string;
  revisionId: string;
  text: string;
  state: SpanState;
  approverIds: string[];
  disapproverIds: string[];
  /** True when an idempotency key replayed an action already recorded */
  replayed: boolean;
}

interface SpanCommandBase {
  workspaceId: string;
  spanId: string;
  userId: string;
  /** The revision the person had in front of them */
  expectedRevisionId: string;
  idempotencyKey?: string | null;
}

export interface DecisionCommand extends SpanCommandBase {
  kind: TranscriptDecisionKind;
}

export interface EditCommand extends SpanCommandBase {
  text: string;
}

type TransactionClient = Prisma.TransactionClient;

interface LockedSpan {
  id: string;
  workspaceId: string;
  currentRevisionId: string;
}

/**
 * Take the span for the length of one short transaction and confirm that the
 * caller was looking at its current revision.
 *
 * This is the whole concurrency story in v1. Leases would add expiry and
 * recovery state to save a rare collision; a revision check makes a lost
 * update impossible, which is the part that matters.
 */
async function lockSpan(
  tx: TransactionClient,
  command: SpanCommandBase
): Promise<LockedSpan> {
  const rows = await tx.$queryRaw<
    { id: string; workspace_id: string; current_revision_id: string | null }[]
  >`
    SELECT "id", "workspace_id", "current_revision_id"
    FROM "transcript_span"
    WHERE "id" = ${command.spanId}::uuid
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row || row.workspace_id !== command.workspaceId) {
    throw new CorrectionError("SPAN_NOT_FOUND", "Span not found in this workspace");
  }
  if (!row.current_revision_id) {
    throw new CorrectionError("SPAN_NOT_FOUND", "Span has no current revision");
  }
  if (row.current_revision_id !== command.expectedRevisionId) {
    throw new CorrectionError(
      "REVISION_CONFLICT",
      "Somebody changed this span while you were working on it",
      { currentRevisionId: row.current_revision_id }
    );
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    currentRevisionId: row.current_revision_id,
  };
}

/**
 * A workspace locked by an in-flight publication takes no writes: a snapshot
 * is being materialized from exactly these revisions.
 *
 * Callers hold the workspace lock before asking, so the answer cannot go stale
 * between the question and the write.
 */
async function assertWorkspaceWritable(
  tx: TransactionClient,
  workspaceId: string
): Promise<void> {
  const workspace = await tx.transcriptWorkspace.findUnique({
    where: { id: workspaceId },
    select: {
      status: true,
      publications: {
        where: { status: { in: ["PENDING", "ACTIVATING"] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction workspace not found");
  }
  if (workspace.status === "ARCHIVED") {
    throw new CorrectionError(
      "WORKSPACE_ARCHIVED",
      "This correction workspace has been archived"
    );
  }
  if (workspace.publications.length > 0) {
    throw new CorrectionError(
      "WORKSPACE_LOCKED",
      "A publication is in progress; the workspace takes no changes until it finishes",
      { publicationId: workspace.publications[0].id }
    );
  }
}

/**
 * Recognize a retry of the same command, and refuse a different one.
 *
 * A key identifies one action on one span, not "whatever this person sends
 * next". Matching on the key alone would let a client that reuses a key report
 * a disapproval as the earlier approval's success — the objection silently
 * discarded while the span stays publishable.
 */
/** Names the command an idempotency key belongs to, payload included. */
export interface CommandIdentity {
  name: "approve" | "disapprove" | "withdraw" | "save_and_approve";
  /** Normalized payload, empty for commands that carry none */
  payload: string;
}

function digestCommand(identity: CommandIdentity): string {
  return hashSpanText(`${identity.name}\u0000${identity.payload}`);
}

/**
 * Recognize a retry of the same command, and refuse a different one.
 *
 * A key identifies one command on one span — the operation *and* what it
 * carried. The decision kind cannot stand in for that: an edit and a bare
 * approval both store APPROVE, so comparing kinds would let a retry under an
 * earlier key silently discard edited text, and would treat two edits with
 * different wording as the same command.
 */
async function findReplay(
  tx: TransactionClient,
  command: SpanCommandBase,
  identity: CommandIdentity
): Promise<{ spanId: string; revisionId: string } | null> {
  if (!command.idempotencyKey) return null;

  const existing = await tx.transcriptSpanDecision.findUnique({
    where: {
      workspaceId_actorKey_idempotencyKey: {
        workspaceId: command.workspaceId,
        actorKey: command.userId,
        idempotencyKey: command.idempotencyKey,
      },
    },
    select: {
      spanId: true,
      revisionId: true,
      commandName: true,
      commandDigest: true,
    },
  });

  if (!existing) return null;

  const digest = digestCommand(identity);
  if (
    existing.spanId !== command.spanId ||
    existing.commandName !== identity.name ||
    existing.commandDigest !== digest
  ) {
    throw new CorrectionError(
      "IDEMPOTENCY_CONFLICT",
      "That idempotency key was already used for a different command",
      { recordedCommand: existing.commandName, recordedSpanId: existing.spanId }
    );
  }

  return { spanId: existing.spanId, revisionId: existing.revisionId };
}

async function summarizeSpan(
  tx: TransactionClient,
  spanId: string,
  revisionId: string
): Promise<Omit<SpanCommandResult, "replayed">> {
  const [revision, decisions] = await Promise.all([
    tx.transcriptSpanRevision.findUniqueOrThrow({
      where: { id: revisionId },
      select: { id: true, text: true },
    }),
    tx.transcriptSpanDecision.findMany({
      where: { revisionId },
      select: { actorKey: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const summary = summarizeSpanDecisions(decisions);

  return {
    spanId,
    revisionId: revision.id,
    text: revision.text,
    state: summary.state,
    approverIds: summary.approverIds,
    disapproverIds: summary.disapproverIds,
  };
}

/** Approve, disapprove or withdraw the current revision of one span. */
export async function recordDecision(
  command: DecisionCommand
): Promise<SpanCommandResult> {
  return prisma.$transaction(async (tx) => {
    const identity: CommandIdentity = {
      name:
        command.kind === "APPROVE"
          ? "approve"
          : command.kind === "DISAPPROVE"
            ? "disapprove"
            : "withdraw",
      payload: "",
    };
    const replay = await findReplay(tx, command, identity);
    if (replay) {
      return {
        ...(await summarizeSpan(tx, replay.spanId, replay.revisionId)),
        replayed: true,
      };
    }

    await lockWorkspace(tx, command.workspaceId);
    await assertWorkspaceWritable(tx, command.workspaceId);
    const span = await lockSpan(tx, command);

    await tx.transcriptSpanDecision.create({
      data: {
        workspaceId: command.workspaceId,
        spanId: span.id,
        revisionId: span.currentRevisionId,
        actorKey: command.userId,
        userId: command.userId,
        kind: command.kind,
        idempotencyKey: command.idempotencyKey ?? null,
        commandName: identity.name,
        commandDigest: digestCommand(identity),
      },
    });

    return {
      ...(await summarizeSpan(tx, span.id, span.currentRevisionId)),
      replayed: false,
    };
  });
}

/**
 * Save an edit and approve it in one transaction.
 *
 * There is no persistent save without a decision: an unfinished edit stays a
 * local draft, so nothing half-considered ever sits in the database waiting to
 * be mistaken for reviewed text.
 */
export async function saveAndApprove(
  command: EditCommand
): Promise<SpanCommandResult> {
  const normalized = normalizeSpanText(command.text);
  if (!isPublishableSpanText(normalized)) {
    throw new CorrectionError(
      "EMPTY_TEXT",
      "A span cannot be emptied; disapprove it instead if the words are unclear"
    );
  }

  return prisma.$transaction(async (tx) => {
    // An edit is stored with the editor's approval, so its recorded kind is
    // APPROVE; the command identity is what distinguishes it from one.
    const identity: CommandIdentity = {
      name: "save_and_approve",
      payload: normalized,
    };
    const replay = await findReplay(tx, command, identity);
    if (replay) {
      return {
        ...(await summarizeSpan(tx, replay.spanId, replay.revisionId)),
        replayed: true,
      };
    }

    await lockWorkspace(tx, command.workspaceId);
    await assertWorkspaceWritable(tx, command.workspaceId);
    const span = await lockSpan(tx, command);

    const current = await tx.transcriptSpanRevision.findUniqueOrThrow({
      where: { id: span.currentRevisionId },
      select: { id: true, text: true },
    });

    // Text that normalizes to the current value is not a change, so it creates
    // no revision and invalidates nobody's decision; the approval still counts.
    const unchanged = current.text === normalized;
    const revisionId = unchanged ? current.id : randomUUID();

    if (!unchanged) {
      await tx.transcriptSpanRevision.create({
        data: {
          id: revisionId,
          workspaceId: command.workspaceId,
          spanId: span.id,
          text: normalized,
          textHash: hashSpanText(normalized),
          previousRevisionId: current.id,
          authorId: command.userId,
        },
      });
      await tx.transcriptSpan.update({
        where: { id: span.id },
        data: { currentRevisionId: revisionId },
      });
    }

    await tx.transcriptSpanDecision.create({
      data: {
        workspaceId: command.workspaceId,
        spanId: span.id,
        revisionId,
        actorKey: command.userId,
        userId: command.userId,
        kind: "APPROVE",
        idempotencyKey: command.idempotencyKey ?? null,
        commandName: identity.name,
        commandDigest: digestCommand(identity),
      },
    });

    return {
      ...(await summarizeSpan(tx, span.id, revisionId)),
      replayed: false,
    };
  });
}

export interface CommentCommand {
  workspaceId: string;
  spanId: string;
  userId: string;
  revisionId: string;
  body: string;
}

/**
 * Comments do not fail merely because the text moved while one was being
 * written: they belong to the span and record the revision its author saw.
 */
export async function addComment(command: CommentCommand): Promise<{
  id: string;
  createdAt: Date;
}> {
  const body = command.body.trim();
  if (!body) {
    throw new CorrectionError("EMPTY_TEXT", "A comment cannot be empty");
  }

  const span = await prisma.transcriptSpan.findUnique({
    where: { id: command.spanId },
    select: { id: true, workspaceId: true },
  });
  if (!span || span.workspaceId !== command.workspaceId) {
    throw new CorrectionError("SPAN_NOT_FOUND", "Span not found in this workspace");
  }

  const revision = await prisma.transcriptSpanRevision.findUnique({
    where: { id: command.revisionId },
    select: { id: true, spanId: true },
  });
  if (!revision || revision.spanId !== command.spanId) {
    throw new CorrectionError(
      "REVISION_CONFLICT",
      "That revision does not belong to this span"
    );
  }

  const comment = await prisma.transcriptSpanComment.create({
    data: {
      workspaceId: command.workspaceId,
      spanId: command.spanId,
      revisionId: command.revisionId,
      actorKey: command.userId,
      authorId: command.userId,
      body,
    },
    select: { id: true, createdAt: true },
  });

  return comment;
}

export interface SpanHistoryEntry {
  kind: "revision" | "decision" | "comment";
  at: Date;
  /** Immutable actor identity; present even after the account is deleted */
  userId: string | null;
  /** Display name for that actor, null when the account no longer exists */
  actorName: string | null;
  revisionId: string;
  text?: string;
  decision?: TranscriptDecisionKind;
  body?: string;
}

/**
 * Who did what, and when.
 *
 * Correctors are not anonymous to one another: this group resolves
 * disagreement by talking, which needs names.
 */
export async function listSpanHistory(
  workspaceId: string,
  spanId: string
): Promise<SpanHistoryEntry[]> {
  // Scoped, not just authorized. A span id is enough to name a span anywhere
  // in the database, so a caller authorized for one workspace must not be able
  // to read another's revisions, comments and participants by supplying its id.
  const span = await prisma.transcriptSpan.findUnique({
    where: { id: spanId },
    select: { workspaceId: true },
  });
  if (!span || span.workspaceId !== workspaceId) {
    throw new CorrectionError("SPAN_NOT_FOUND", "Span not found in this workspace");
  }

  const [revisions, decisions, comments] = await Promise.all([
    prisma.transcriptSpanRevision.findMany({
      where: { spanId },
      select: { id: true, text: true, authorId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.transcriptSpanDecision.findMany({
      where: { spanId },
      select: { revisionId: true, actorKey: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.transcriptSpanComment.findMany({
      where: { spanId },
      select: { revisionId: true, actorKey: true, body: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const entries: SpanHistoryEntry[] = [
    ...revisions.map((revision) => ({
      kind: "revision" as const,
      at: revision.createdAt,
      userId: revision.authorId,
      actorName: null,
      revisionId: revision.id,
      text: revision.text,
    })),
    ...decisions.map((decision) => ({
      kind: "decision" as const,
      at: decision.createdAt,
      userId: decision.actorKey,
      actorName: null,
      revisionId: decision.revisionId,
      decision: decision.kind,
    })),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      at: comment.createdAt,
      userId: comment.actorKey,
      actorName: null,
      revisionId: comment.revisionId,
      body: comment.body,
    })),
  ];

  // Correctors are not anonymous to one another: this group resolves
  // disagreement by talking, which needs names rather than opaque ids. A
  // deleted account keeps its place in the history and simply has no name.
  const actorKeys = [
    ...new Set(entries.map((entry) => entry.userId).filter((id): id is string => id !== null)),
  ];
  const actors =
    actorKeys.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: actorKeys } },
          select: { id: true, name: true, email: true },
        });
  const nameByKey = new Map(
    actors.map((actor) => [actor.id, actor.name ?? actor.email ?? null])
  );

  for (const entry of entries) {
    entry.actorName = entry.userId ? (nameByKey.get(entry.userId) ?? null) : null;
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}
