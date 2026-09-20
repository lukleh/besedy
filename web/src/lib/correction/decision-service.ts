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

async function findReplay(
  tx: TransactionClient,
  workspaceId: string,
  userId: string,
  idempotencyKey: string | null | undefined
): Promise<{ spanId: string; revisionId: string } | null> {
  if (!idempotencyKey) return null;

  const existing = await tx.transcriptSpanDecision.findUnique({
    where: {
      workspaceId_userId_idempotencyKey: {
        workspaceId,
        userId,
        idempotencyKey,
      },
    },
    select: { spanId: true, revisionId: true },
  });

  return existing;
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
      select: { userId: true, kind: true, createdAt: true },
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
    const replay = await findReplay(
      tx,
      command.workspaceId,
      command.userId,
      command.idempotencyKey
    );
    if (replay) {
      return {
        ...(await summarizeSpan(tx, replay.spanId, replay.revisionId)),
        replayed: true,
      };
    }

    await assertWorkspaceWritable(tx, command.workspaceId);
    const span = await lockSpan(tx, command);

    await tx.transcriptSpanDecision.create({
      data: {
        workspaceId: command.workspaceId,
        spanId: span.id,
        revisionId: span.currentRevisionId,
        userId: command.userId,
        kind: command.kind,
        idempotencyKey: command.idempotencyKey ?? null,
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
    const replay = await findReplay(
      tx,
      command.workspaceId,
      command.userId,
      command.idempotencyKey
    );
    if (replay) {
      return {
        ...(await summarizeSpan(tx, replay.spanId, replay.revisionId)),
        replayed: true,
      };
    }

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
        userId: command.userId,
        kind: "APPROVE",
        idempotencyKey: command.idempotencyKey ?? null,
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
  userId: string | null;
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
  spanId: string
): Promise<SpanHistoryEntry[]> {
  const [revisions, decisions, comments] = await Promise.all([
    prisma.transcriptSpanRevision.findMany({
      where: { spanId },
      select: { id: true, text: true, authorId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.transcriptSpanDecision.findMany({
      where: { spanId },
      select: { revisionId: true, userId: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.transcriptSpanComment.findMany({
      where: { spanId },
      select: { revisionId: true, authorId: true, body: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const entries: SpanHistoryEntry[] = [
    ...revisions.map((revision) => ({
      kind: "revision" as const,
      at: revision.createdAt,
      userId: revision.authorId,
      revisionId: revision.id,
      text: revision.text,
    })),
    ...decisions.map((decision) => ({
      kind: "decision" as const,
      at: decision.createdAt,
      userId: decision.userId,
      revisionId: decision.revisionId,
      decision: decision.kind,
    })),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      at: comment.createdAt,
      userId: comment.authorId,
      revisionId: comment.revisionId,
      body: comment.body,
    })),
  ];

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}
