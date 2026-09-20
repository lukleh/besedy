import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  Prisma,
  type TranscriptDecisionKind,
  type TranscriptPublicationStatus,
} from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";
import { isCorrectionEligibleRecording } from "@/lib/correction/eligibility";
import {
  readMachineSource,
  resolveConfiguredDefaultBackend,
  type CanonicalSegment,
} from "@/lib/correction/source";
import {
  resolveWorkspaceDir,
  resolveWorkspaceSourcePath,
  writeFileAtomic,
} from "@/lib/correction/storage";
import {
  fingerprintContent,
  hashSpanText,
  normalizeSpanText,
} from "@/lib/correction/text";
import {
  hasBeenReviewed,
  summarizeSpanDecisions,
  type SpanState,
} from "@/lib/correction/span-state";
import { lockWorkspace } from "@/lib/correction/workspace-lock";

interface SpanDecisionRow {
  spanId: string;
  actorKey: string;
  kind: TranscriptDecisionKind;
  createdAt: Date;
}

export interface WorkspaceSummary {
  id: string;
  catalogId: string;
  audioHash: string;
  sourceBackend: string;
  sourceFingerprint: string;
  spanCount: number;
  spanDurationSeconds: number;
  status: "ACTIVE" | "ARCHIVED";
  readerPublicationId: string | null;
  searchPublicationId: string | null;
  lockedByPublicationId: string | null;
  startedById: string | null;
  createdAt: Date;
}

export interface SpanView {
  id: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  originalText: string;
  text: string;
  revisionId: string;
  isEdited: boolean;
  state: SpanState;
  approverIds: string[];
  disapproverIds: string[];
  commentCount: number;
  lastEditedById: string | null;
  lastEditedAt: Date | null;
}

export interface CorrectionProgress {
  spanCount: number;
  totalDurationSeconds: number;
  /** Duration covered by spans somebody has taken a position on */
  reviewedOnceDurationSeconds: number;
  /** Duration covered by done spans */
  fullyApprovedDurationSeconds: number;
  doneSpanCount: number;
  blockedSpanCount: number;
}

function toSummary(workspace: {
  id: string;
  workflowGroupId: string;
  audioHash: string;
  sourceBackend: string;
  sourceFingerprint: string;
  spanCount: number;
  spanDurationSeconds: number;
  status: "ACTIVE" | "ARCHIVED";
  readerPublicationId: string | null;
  searchPublicationId: string | null;
  startedById: string | null;
  createdAt: Date;
  publications?: { id: string }[];
}): WorkspaceSummary {
  return {
    id: workspace.id,
    catalogId: workspace.workflowGroupId,
    audioHash: workspace.audioHash,
    sourceBackend: workspace.sourceBackend,
    sourceFingerprint: workspace.sourceFingerprint,
    spanCount: workspace.spanCount,
    spanDurationSeconds: workspace.spanDurationSeconds,
    status: workspace.status,
    readerPublicationId: workspace.readerPublicationId,
    searchPublicationId: workspace.searchPublicationId,
    lockedByPublicationId: workspace.publications?.[0]?.id ?? null,
    startedById: workspace.startedById,
    createdAt: workspace.createdAt,
  };
}

const IN_FLIGHT_STATUSES: TranscriptPublicationStatus[] = ["PENDING", "ACTIVATING"];

const WORKSPACE_SELECT = {
  id: true,
  workflowGroupId: true,
  audioHash: true,
  sourceBackend: true,
  sourceFingerprint: true,
  spanCount: true,
  spanDurationSeconds: true,
  status: true,
  readerPublicationId: true,
  searchPublicationId: true,
  startedById: true,
  createdAt: true,
  publications: {
    where: { status: { in: IN_FLIGHT_STATUSES } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.TranscriptWorkspaceSelect;

/** The live workspace for a recording, or null when correction never started. */
export async function findActiveWorkspace(
  catalogId: string,
  audioHash: string
): Promise<WorkspaceSummary | null> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: WORKSPACE_SELECT,
  });

  return workspace ? toSummary(workspace) : null;
}

export async function requireActiveWorkspace(
  catalogId: string,
  audioHash: string
): Promise<WorkspaceSummary> {
  const workspace = await findActiveWorkspace(catalogId, audioHash);
  if (!workspace) {
    throw new CorrectionError(
      "NO_WORKSPACE",
      "Correction has not been started for this recording"
    );
  }
  return workspace;
}

export interface StartWorkspaceInput {
  catalogId: string;
  audioHash: string;
  transcriptsPath: string;
  userId: string;
  /** Guards against starting a different source than the one that was offered */
  expectedBackend?: string | null;
}

/**
 * Freeze one machine transcript and import its segments as spans.
 *
 * Rows are created eagerly rather than on first edit: an unstarted recording
 * then costs nothing, and a started one is completely independent of later
 * retranscription, backend-priority changes or source-file replacement.
 */
export async function startWorkspace(
  input: StartWorkspaceInput
): Promise<WorkspaceSummary> {
  const { catalogId, audioHash, transcriptsPath, userId } = input;

  if (!(await isCorrectionEligibleRecording(catalogId, audioHash))) {
    throw new CorrectionError(
      "NOT_ELIGIBLE",
      "Only the primary recording of an event can be corrected"
    );
  }

  const existing = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: { id: true },
  });
  if (existing) {
    throw new CorrectionError(
      "WORKSPACE_EXISTS",
      "Correction has already been started for this recording"
    );
  }

  const backend = await resolveConfiguredDefaultBackend(transcriptsPath, audioHash);
  if (!backend) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      "This recording has no machine transcript to correct"
    );
  }
  if (input.expectedBackend && input.expectedBackend !== backend) {
    throw new CorrectionError(
      "REVISION_CONFLICT",
      `The default machine transcript is now ${backend}, not ${input.expectedBackend}`,
      { backend }
    );
  }

  const source = await readMachineSource(transcriptsPath, audioHash, backend);
  const sourceFingerprint = fingerprintContent(source.content);

  const workspaceId = randomUUID();
  const spans = buildSpanRows(source.data.segments ?? []);
  if (spans.length === 0) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      "The machine transcript has no usable segments"
    );
  }

  const spanDurationSeconds = spans.reduce(
    (total, span) => total + Math.max(0, span.endSeconds - span.startSeconds),
    0
  );

  // The immutable copy lands first: a workspace whose frozen source is missing
  // would be unrecoverable, while an orphan file is merely rubbish.
  await writeFileAtomic(
    resolveWorkspaceSourcePath(catalogId, workspaceId),
    source.content
  );

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.transcriptWorkspace.create({
          data: {
            id: workspaceId,
            workflowGroupId: catalogId,
            audioHash,
            sourceBackend: backend,
            sourceFingerprint,
            spanCount: spans.length,
            spanDurationSeconds,
            startedById: userId,
          },
        });

        await tx.transcriptSpan.createMany({
          data: spans.map((span) => ({
            id: span.id,
            workspaceId,
            ordinal: span.ordinal,
            startSeconds: span.startSeconds,
            endSeconds: span.endSeconds,
            originalText: span.text,
            originalTextHash: span.textHash,
          })),
        });

        await tx.transcriptSpanRevision.createMany({
          data: spans.map((span) => ({
            id: span.revisionId,
            workspaceId,
            spanId: span.id,
            text: span.text,
            textHash: span.textHash,
            authorId: null,
          })),
        });

        // The span and its first revision reference each other, so the pointer
        // is set once both rows exist, in one statement rather than per span.
        await tx.$executeRaw`
          UPDATE "transcript_span" AS s
          SET "current_revision_id" = r."id"
          FROM "transcript_span_revision" AS r
          WHERE r."span_id" = s."id"
            AND r."previous_revision_id" IS NULL
            AND s."workspace_id" = ${workspaceId}::uuid
        `;
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  } catch (error) {
    await fs.rm(resolveWorkspaceDir(catalogId, workspaceId), {
      recursive: true,
      force: true,
    });
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new CorrectionError(
        "WORKSPACE_EXISTS",
        "Correction has already been started for this recording"
      );
    }
    throw error;
  }

  return requireActiveWorkspace(catalogId, audioHash);
}

interface ImportedSpan {
  id: string;
  revisionId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  textHash: string;
}

function buildSpanRows(segments: readonly CanonicalSegment[]): ImportedSpan[] {
  const rows: ImportedSpan[] = [];

  for (const segment of segments) {
    const text = normalizeSpanText(String(segment.text ?? ""));
    if (!text) continue;

    const start = Number(segment.start ?? 0);
    const end = Number(segment.end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    rows.push({
      id: randomUUID(),
      revisionId: randomUUID(),
      ordinal: rows.length,
      startSeconds: Math.max(0, start),
      endSeconds: Math.max(Math.max(0, start), end),
      text,
      textHash: hashSpanText(text),
    });
  }

  return rows;
}

export interface SpanPage {
  spans: SpanView[];
  total: number;
}

/**
 * Spans with their derived state.
 *
 * Only decisions bound to each span's current revision are loaded, so a
 * superseded approval cannot leak into the count.
 */
export async function listSpans(
  workspaceId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<SpanPage> {
  const [total, spans] = await Promise.all([
    prisma.transcriptSpan.count({ where: { workspaceId } }),
    prisma.transcriptSpan.findMany({
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
            authorId: true,
            createdAt: true,
            previousRevisionId: true,
          },
        },
      },
    }),
  ]);

  const revisionIds = spans
    .map((span) => span.currentRevisionId)
    .filter((id): id is string => id !== null);

  const [decisions, commentCounts] = await Promise.all([
    revisionIds.length === 0
      ? Promise.resolve<SpanDecisionRow[]>([])
      : prisma.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: {
            spanId: true,
            actorKey: true,
            kind: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
    spans.length === 0
      ? Promise.resolve<{ spanId: string; _count: { _all: number } }[]>([])
      : prisma.transcriptSpanComment.groupBy({
          by: ["spanId"],
          where: { spanId: { in: spans.map((span) => span.id) } },
          _count: { _all: true },
        }),
  ]);

  const decisionsBySpan = new Map<string, SpanDecisionRow[]>();
  for (const decision of decisions) {
    const bucket = decisionsBySpan.get(decision.spanId);
    if (bucket) bucket.push(decision);
    else decisionsBySpan.set(decision.spanId, [decision]);
  }

  const commentCountBySpan = new Map(
    commentCounts.map((row) => [row.spanId, row._count._all])
  );

  return {
    total,
    spans: spans.map((span) => {
      const summary = summarizeSpanDecisions(decisionsBySpan.get(span.id) ?? []);
      const revision = span.currentRevision;
      return {
        id: span.id,
        ordinal: span.ordinal,
        startSeconds: span.startSeconds,
        endSeconds: span.endSeconds,
        originalText: span.originalText,
        text: revision?.text ?? span.originalText,
        revisionId: revision?.id ?? "",
        isEdited: revision?.previousRevisionId != null,
        state: summary.state,
        approverIds: summary.approverIds,
        disapproverIds: summary.disapproverIds,
        commentCount: commentCountBySpan.get(span.id) ?? 0,
        lastEditedById: revision?.authorId ?? null,
        lastEditedAt: revision?.authorId ? revision.createdAt : null,
      };
    }),
  };
}

/**
 * Duration-weighted progress.
 *
 * Machine segments vary from a word to a paragraph, so counting them would
 * describe the work badly; the reader panel and the publication check both
 * reason in seconds of audio.
 */
export async function computeProgress(
  workspaceId: string
): Promise<CorrectionProgress> {
  const spans = await prisma.transcriptSpan.findMany({
    where: { workspaceId },
    select: {
      id: true,
      startSeconds: true,
      endSeconds: true,
      currentRevisionId: true,
    },
  });

  const revisionIds = spans
    .map((span) => span.currentRevisionId)
    .filter((id): id is string => id !== null);

  const decisions: SpanDecisionRow[] =
    revisionIds.length === 0
      ? []
      : await prisma.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: { spanId: true, actorKey: true, kind: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        });

  const decisionsBySpan = new Map<string, SpanDecisionRow[]>();
  for (const decision of decisions) {
    const bucket = decisionsBySpan.get(decision.spanId);
    if (bucket) bucket.push(decision);
    else decisionsBySpan.set(decision.spanId, [decision]);
  }

  let totalDurationSeconds = 0;
  let reviewedOnceDurationSeconds = 0;
  let fullyApprovedDurationSeconds = 0;
  let doneSpanCount = 0;
  let blockedSpanCount = 0;

  for (const span of spans) {
    const duration = Math.max(0, span.endSeconds - span.startSeconds);
    totalDurationSeconds += duration;

    const summary = summarizeSpanDecisions(decisionsBySpan.get(span.id) ?? []);
    if (hasBeenReviewed(summary)) reviewedOnceDurationSeconds += duration;
    if (summary.isDone) {
      fullyApprovedDurationSeconds += duration;
      doneSpanCount += 1;
    }
    if (summary.state === "needs_attention") blockedSpanCount += 1;
  }

  return {
    spanCount: spans.length,
    totalDurationSeconds,
    reviewedOnceDurationSeconds,
    fullyApprovedDurationSeconds,
    doneSpanCount,
    blockedSpanCount,
  };
}

export interface ArchiveWorkspaceInput {
  catalogId: string;
  audioHash: string;
  userId: string;
  reason: string;
}

/**
 * Abandon a workspace so a new one can be started over the right source.
 *
 * There is no restart or rebase: corrections are not relocated onto new
 * machine segments, and nothing is deleted. The row stays for audit, and the
 * partial unique index permits exactly one live workspace per recording, so
 * archiving is what makes room for the replacement.
 *
 * A workspace whose corrections are still the transcript somebody reads or
 * searches cannot be archived, because doing so would silently take that
 * transcript away. Unpublish and withdraw it from search first; those are
 * deliberate acts of their own.
 */
export async function archiveWorkspace(
  input: ArchiveWorkspaceInput
): Promise<WorkspaceSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new CorrectionError(
      "EMPTY_TEXT",
      "Archiving a workspace needs a reason, because nothing else records why"
    );
  }

  const existing = await prisma.transcriptWorkspace.findFirst({
    where: {
      workflowGroupId: input.catalogId,
      audioHash: input.audioHash,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (!existing) {
    throw new CorrectionError(
      "NO_WORKSPACE",
      "Correction has not been started for this recording"
    );
  }

  const archived = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, existing.id);

    const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: existing.id },
      select: WORKSPACE_SELECT,
    });

    if (workspace.publications.length > 0) {
      throw new CorrectionError(
        "WORKSPACE_LOCKED",
        "A publication is in progress; it has to finish or be rolled back first",
        { publicationId: workspace.publications[0].id }
      );
    }
    if (workspace.readerPublicationId || workspace.searchPublicationId) {
      throw new CorrectionError(
        "PUBLICATION_ACTIVE",
        "This workspace still backs a published transcript; unpublish it and withdraw it from search first"
      );
    }

    return tx.transcriptWorkspace.update({
      where: { id: existing.id },
      data: {
        status: "ARCHIVED",
        archivedAt: new Date(),
        archivedById: input.userId,
        archiveReason: reason,
      },
      select: WORKSPACE_SELECT,
    });
  });

  return toSummary(archived);
}

export interface ResumePosition {
  spanId: string;
  ordinal: number;
}

/**
 * Where this person should pick the work up.
 *
 * A three-hour recording runs to several hundred spans and nobody finishes one
 * in a sitting, so opening at the first span every time would make resuming a
 * scrolling exercise. This answers "what still wants me": the earliest span
 * that is not done and that this person has not already approved. A span
 * others have finished is not their problem, and one they objected to still
 * is, because it is theirs to withdraw or have addressed.
 */
export async function findResumePosition(
  workspaceId: string,
  actorKey: string
): Promise<ResumePosition | null> {
  const spans = await prisma.transcriptSpan.findMany({
    where: { workspaceId },
    orderBy: { ordinal: "asc" },
    select: { id: true, ordinal: true, currentRevisionId: true },
  });

  const revisionIds = spans
    .map((span) => span.currentRevisionId)
    .filter((id): id is string => id !== null);

  const decisions: SpanDecisionRow[] =
    revisionIds.length === 0
      ? []
      : await prisma.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: { spanId: true, actorKey: true, kind: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        });

  const decisionsBySpan = new Map<string, SpanDecisionRow[]>();
  for (const decision of decisions) {
    const bucket = decisionsBySpan.get(decision.spanId);
    if (bucket) bucket.push(decision);
    else decisionsBySpan.set(decision.spanId, [decision]);
  }

  for (const span of spans) {
    const summary = summarizeSpanDecisions(decisionsBySpan.get(span.id) ?? []);
    if (summary.isDone) continue;
    if (summary.approverIds.includes(actorKey)) continue;
    return { spanId: span.id, ordinal: span.ordinal };
  }

  return null;
}
