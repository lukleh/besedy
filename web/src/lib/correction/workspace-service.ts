import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Prisma, type TranscriptPublicationStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";
import { isCorrectionEligibleRecording } from "@/lib/correction/eligibility";
import { readMachineSource, resolveConfiguredDefaultBackend } from "@/lib/correction/source";
import {
  readJsonFile,
  resolveWorkspaceDir,
  resolveWorkspaceManifestPath,
  resolveWorkspaceSourcePath,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  writeFileAtomic,
  writeWorkspaceManifest,
  type CorrectionWorkspaceManifest,
} from "@/lib/correction/storage";
import { requireContributorConsent } from "@/lib/correction/consent";
import { getActiveGuideRevisionId } from "@/lib/correction/guide";
import {
  SEGMENTATION_PARAMS,
  SegmentationError,
  segmentTranscript,
  type Segmentation,
} from "@/lib/correction/segmentation";
import { identifyStagedAudio } from "@/lib/correction/staged-audio";
import { fingerprintContent, hashSpanText } from "@/lib/correction/text";
import type { SpanState } from "@/lib/correction/span-state";
import { loadSpanSummaries, type SpanSummaryRow } from "@/lib/correction/span-summaries";
import {
  findNextSpan,
  loadWorkspaceAggregates,
  type SpanPosition,
  type WorkspaceAggregate,
} from "@/lib/correction/span-queries";
import {
  eligibilityOfAggregate,
  type PublicationEligibility,
} from "@/lib/correction/publication-eligibility";
import { lockWorkspace } from "@/lib/correction/workspace-lock";

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

const IN_FLIGHT_STATUSES: TranscriptPublicationStatus[] = ["PENDING", "ACTIVATING", "ROLLING_BACK"];

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
  searchWithdrawalId: true,
  startedById: true,
  createdAt: true,
  publications: {
    where: { status: { in: IN_FLIGHT_STATUSES } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.TranscriptWorkspaceSelect;

/** The live workspace for a recording, or null when correction never started. */
export async function findActiveWorkspace(catalogId: string, audioHash: string): Promise<WorkspaceSummary | null> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: WORKSPACE_SELECT,
  });

  return workspace ? toSummary(workspace) : null;
}

export async function requireActiveWorkspace(catalogId: string, audioHash: string): Promise<WorkspaceSummary> {
  const workspace = await findActiveWorkspace(catalogId, audioHash);
  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started for this recording");
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
 * Freeze one machine transcript and import its decoded chunks as spans.
 *
 * Rows are created eagerly rather than on first edit: an unstarted recording
 * then costs nothing, and a started one is completely independent of later
 * retranscription, backend-priority changes or source-file replacement.
 *
 * ADR 0012 makes the import the moment the correction data contract is fixed:
 * spans are cut from the chunks the model decoded, the staged audio their times
 * refer to is fingerprinted, and nothing starts without the starter's consent
 * and a catalog guide revision every machine revision can point at.
 */
export async function startWorkspace(input: StartWorkspaceInput): Promise<WorkspaceSummary> {
  const { catalogId, audioHash, transcriptsPath, userId } = input;

  await requireContributorConsent(prisma, userId);

  if (!(await isCorrectionEligibleRecording(catalogId, audioHash))) {
    throw new CorrectionError("NOT_ELIGIBLE", "Only the primary recording of an event can be corrected");
  }

  const guideRevisionId = await getActiveGuideRevisionId(catalogId);
  if (!guideRevisionId) {
    throw new CorrectionError(
      "GUIDE_MISSING",
      "Save this catalog's correction guide before starting correction, so every revision records the guide it followed"
    );
  }

  const existing = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: { id: true },
  });
  if (existing) {
    throw new CorrectionError("WORKSPACE_EXISTS", "Correction has already been started for this recording");
  }

  const backend = await resolveConfiguredDefaultBackend(transcriptsPath, audioHash);
  if (!backend) {
    throw new CorrectionError("SOURCE_MISSING", "This recording has no machine transcript to correct");
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

  let segmentation: Segmentation;
  try {
    segmentation = segmentTranscript(source.data);
  } catch (error) {
    if (error instanceof SegmentationError) {
      throw new CorrectionError(
        "SOURCE_UNSUITABLE",
        `This machine transcript cannot be cut into correction spans: ${error.message}`,
        { reason: error.code }
      );
    }
    throw error;
  }
  const stagedAudio = await identifyStagedAudio(source.data.meta, audioHash);

  const workspaceId = randomUUID();
  const spans = buildSpanRows(segmentation);
  const spanDurationSeconds = spans.reduce(
    (total, span) => total + (span.endSample - span.startSample) / SEGMENTATION_PARAMS.sampleRate,
    0
  );

  // The immutable copy lands first: a workspace whose frozen source is missing
  // would be unrecoverable, while an orphan file is merely rubbish. The
  // manifest follows as `starting`, so its staged audio is protected before
  // any row exists; it becomes `active` only once the rows are committed, so a
  // crash in between leaves a manifest the Python guard can recognise as
  // abandoned (still `starting` after an hour) instead of one that protects
  // nothing forever.
  await writeFileAtomic(resolveWorkspaceSourcePath(catalogId, workspaceId), source.content);
  const writeManifest = (status: "starting" | "active") =>
    writeWorkspaceManifest({
      schema_version: WORKSPACE_MANIFEST_SCHEMA_VERSION,
      workflow_group_id: catalogId,
      audio_hash: audioHash,
      workspace_id: workspaceId,
      status,
      segmentation_version: segmentation.version,
      staged_audio: stagedAudio,
      updated_at: new Date().toISOString(),
    });
  await writeManifest("starting");

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
            segmentationVersion: segmentation.version,
            segmentationParams: { ...SEGMENTATION_PARAMS },
            sourceChunkCount: segmentation.chunkCount,
            stagedAudioPath: stagedAudio.path,
            stagedAudioSize: BigInt(stagedAudio.size),
            stagedAudioSha256: stagedAudio.sha256,
          },
        });

        await tx.transcriptSpan.createMany({
          data: spans.map((span) => ({
            id: span.id,
            workspaceId,
            ordinal: span.ordinal,
            startSeconds: span.startSample / SEGMENTATION_PARAMS.sampleRate,
            endSeconds: span.endSample / SEGMENTATION_PARAMS.sampleRate,
            originalText: span.text,
            originalTextHash: span.textHash,
            chunkOrdinal: span.chunk,
            firstRegionIndex: span.firstRegion,
            lastRegionIndex: span.lastRegion,
            startSample: span.startSample,
            endSample: span.endSample,
            speechRegions: span.speechRegions,
            machineWords: span.machineWords as Prisma.InputJsonValue,
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
            origin: "MACHINE" as const,
            guideRevisionId,
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CorrectionError("WORKSPACE_EXISTS", "Correction has already been started for this recording");
    }
    throw error;
  }

  await writeManifest("active");

  return requireActiveWorkspace(catalogId, audioHash);
}

interface ImportedSpan {
  id: string;
  revisionId: string;
  ordinal: number;
  chunk: number;
  firstRegion: number;
  lastRegion: number;
  startSample: number;
  endSample: number;
  speechRegions: number[][];
  machineWords: Record<string, unknown>[];
  text: string;
  textHash: string;
}

/**
 * One row per segmented span, in order. A span without machine text is
 * imported like any other: two approvals confirm that nothing was said there,
 * or a corrector writes the speech the model dropped.
 */
function buildSpanRows(segmentation: Segmentation): ImportedSpan[] {
  return segmentation.spans.map((span, ordinal) => ({
    id: randomUUID(),
    revisionId: randomUUID(),
    ordinal,
    chunk: span.chunk,
    firstRegion: span.firstRegion,
    lastRegion: span.lastRegion,
    startSample: span.startSample,
    endSample: span.endSample,
    speechRegions: span.regions.map((region) => [region.start, region.end]),
    machineWords: span.words,
    text: span.text,
    textHash: hashSpanText(span.text),
  }));
}

export interface SpanPage {
  spans: SpanView[];
  total: number;
}

/**
 * Spans with their derived state.
 *
 * Only decisions bound to each span's current revision count, so a
 * superseded approval cannot leak into the state.
 */
export async function listSpans(
  workspaceId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<SpanPage> {
  const [total, spans] = await Promise.all([
    prisma.transcriptSpan.count({ where: { workspaceId } }),
    loadSpanSummaries(workspaceId, { offset: options.offset, limit: options.limit }),
  ]);

  const commentCounts =
    spans.length === 0
      ? []
      : await prisma.transcriptSpanComment.groupBy({
          by: ["spanId"],
          where: { spanId: { in: spans.map((span) => span.id) } },
          _count: { _all: true },
        });
  const commentCountBySpan = new Map(commentCounts.map((row) => [row.spanId, row._count._all]));

  return {
    total,
    spans: spans.map((span) => toSpanView(span, commentCountBySpan.get(span.id) ?? 0)),
  };
}

function toSpanView(span: SpanSummaryRow, commentCount: number): SpanView {
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
    state: span.summary.state,
    approverIds: span.summary.approverIds,
    disapproverIds: span.summary.disapproverIds,
    commentCount,
    lastEditedById: revision?.actorKey ?? null,
    lastEditedAt: revision?.actorKey ? revision.createdAt : null,
  };
}

/**
 * Duration-weighted progress.
 *
 * Machine segments vary from a word to a paragraph, so counting them would
 * describe the work badly; the reader panel and the publication check both
 * reason in seconds of audio. "Reviewed" means somebody has taken a position,
 * which is every state but not reviewed.
 */
export function progressOfAggregate(aggregate: WorkspaceAggregate | undefined): CorrectionProgress {
  if (!aggregate) {
    return {
      spanCount: 0,
      totalDurationSeconds: 0,
      reviewedOnceDurationSeconds: 0,
      fullyApprovedDurationSeconds: 0,
      doneSpanCount: 0,
      blockedSpanCount: 0,
    };
  }

  return {
    spanCount: aggregate.spanCount,
    totalDurationSeconds: aggregate.totalSeconds,
    reviewedOnceDurationSeconds: aggregate.totalSeconds - aggregate.seconds.not_reviewed,
    fullyApprovedDurationSeconds: aggregate.seconds.done,
    doneSpanCount: aggregate.counts.done,
    blockedSpanCount: aggregate.counts.needs_attention,
  };
}

export async function computeProgress(workspaceId: string): Promise<CorrectionProgress> {
  const aggregates = await loadWorkspaceAggregates([workspaceId], null);
  return progressOfAggregate(aggregates.get(workspaceId));
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
export async function archiveWorkspace(input: ArchiveWorkspaceInput): Promise<WorkspaceSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new CorrectionError("EMPTY_TEXT", "Archiving a workspace needs a reason, because nothing else records why");
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
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started for this recording");
  }

  const archived = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, existing.id);

    const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: existing.id },
      select: WORKSPACE_SELECT,
    });

    // Looked up before the transaction, so a second administrator archiving at
    // the same moment must not overwrite the first one's reason and name.
    if (workspace.status !== "ACTIVE") {
      throw new CorrectionError("WORKSPACE_ARCHIVED", "This correction workspace has already been archived");
    }
    if (workspace.publications.length > 0) {
      throw new CorrectionError(
        "WORKSPACE_LOCKED",
        "A publication is in progress; it has to finish or be rolled back first",
        { publicationId: workspace.publications[0].id }
      );
    }
    if (workspace.searchWithdrawalId) {
      throw new CorrectionError(
        "WORKSPACE_LOCKED",
        "Withdrawal from search must finish before this workspace can be archived"
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

  // After the commit: if this write fails, the staged audio stays protected,
  // which is the safe direction. Workspaces from before ADR 0012 have none.
  const manifestPath = resolveWorkspaceManifestPath(input.catalogId, existing.id);
  const manifest = await readJsonFile<CorrectionWorkspaceManifest>(manifestPath);
  if (manifest) {
    await writeWorkspaceManifest({ ...manifest, status: "archived", updated_at: new Date().toISOString() });
  }

  return toSummary(archived);
}

export type ResumePosition = SpanPosition;

/** Where this person should pick the work up; see `findNextSpan`. */
export async function findResumePosition(
  workspaceId: string,
  actorKey: string
): Promise<ResumePosition | null> {
  return findNextSpan(workspaceId, actorKey);
}

export interface WorkspaceSummaryForActor {
  progress: CorrectionProgress;
  resume: ResumePosition | null;
  publication: PublicationEligibility;
}

/**
 * Progress, where to resume, and whether the transcript can be published.
 * The correction page asks for all three on every load and after every
 * command; the counts come from one aggregate over the reduced span states.
 */
export async function summarizeWorkspace(
  workspaceId: string,
  actorKey: string
): Promise<WorkspaceSummaryForActor> {
  const [aggregates, resume] = await Promise.all([
    loadWorkspaceAggregates([workspaceId], actorKey),
    findNextSpan(workspaceId, actorKey),
  ]);
  const aggregate = aggregates.get(workspaceId);
  return {
    progress: progressOfAggregate(aggregate),
    resume,
    publication: eligibilityOfAggregate(aggregate),
  };
}
