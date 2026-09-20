import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";
import {
  materializeCorrectedTranscript,
  CORRECTION_PROVENANCE_SCHEMA_VERSION,
} from "@/lib/correction/materialize";
import { renderSrt, renderTxt, renderVtt, type RenderableSegment } from "@/lib/correction/render";
import type { CanonicalTranscript } from "@/lib/correction/source";
import {
  INDEX_POINTER_SCHEMA_VERSION,
  readJsonFile,
  relativeToCorrectionsRoot,
  removeIndexPointer,
  resolvePublicationFilePath,
  resolveWorkspaceSourcePath,
  writeFileAtomic,
  writeIndexPointer,
  readIndexPointer,
} from "@/lib/correction/storage";
import { REQUIRED_APPROVALS, summarizeSpanDecisions } from "@/lib/correction/span-state";
import { fingerprintContent } from "@/lib/correction/text";
import { getActiveGuideRevisionId } from "@/lib/correction/guide";

export interface ManifestEntry {
  spanId: string;
  revisionId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface PublicationEligibility {
  eligible: boolean;
  spanCount: number;
  doneSpanCount: number;
  blockedSpanCount: number;
  unreviewedSpanCount: number;
  awaitingSecondApprovalCount: number;
}

interface WorkspaceEvaluation extends PublicationEligibility {
  manifest: ManifestEntry[];
  durationSeconds: number;
}

/**
 * Re-derive every span's state from its decisions.
 *
 * Publication asks this again at the moment it starts. Nothing is trusted from
 * the page the publisher was looking at, and a publisher cannot override a
 * span that is unfinished or disputed — there is no adjudication in v1.
 */
export async function evaluateWorkspace(
  workspaceId: string
): Promise<WorkspaceEvaluation> {
  const spans = await prisma.transcriptSpan.findMany({
    where: { workspaceId },
    orderBy: { ordinal: "asc" },
    select: {
      id: true,
      ordinal: true,
      startSeconds: true,
      endSeconds: true,
      currentRevisionId: true,
      currentRevision: { select: { id: true, text: true } },
    },
  });

  const revisionIds = spans
    .map((span) => span.currentRevisionId)
    .filter((id): id is string => id !== null);

  const decisions =
    revisionIds.length === 0
      ? []
      : await prisma.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: { spanId: true, userId: true, kind: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        });

  const decisionsBySpan = new Map<string, typeof decisions>();
  for (const decision of decisions) {
    const bucket = decisionsBySpan.get(decision.spanId);
    if (bucket) bucket.push(decision);
    else decisionsBySpan.set(decision.spanId, [decision]);
  }

  const manifest: ManifestEntry[] = [];
  let doneSpanCount = 0;
  let blockedSpanCount = 0;
  let unreviewedSpanCount = 0;
  let awaitingSecondApprovalCount = 0;
  let durationSeconds = 0;

  for (const span of spans) {
    const summary = summarizeSpanDecisions(decisionsBySpan.get(span.id) ?? []);
    switch (summary.state) {
      case "done":
        doneSpanCount += 1;
        break;
      case "needs_attention":
        blockedSpanCount += 1;
        break;
      case "needs_second_approval":
        awaitingSecondApprovalCount += 1;
        break;
      default:
        unreviewedSpanCount += 1;
    }

    durationSeconds += Math.max(0, span.endSeconds - span.startSeconds);

    if (span.currentRevision) {
      manifest.push({
        spanId: span.id,
        revisionId: span.currentRevision.id,
        ordinal: span.ordinal,
        startSeconds: span.startSeconds,
        endSeconds: span.endSeconds,
        text: span.currentRevision.text,
      });
    }
  }

  return {
    // Every span must be done *and* carry a revision to publish. A span
    // without a current revision cannot appear in a manifest, so counting it
    // as eligible would publish a transcript with a hole in it.
    eligible:
      spans.length > 0 &&
      doneSpanCount === spans.length &&
      manifest.length === spans.length,
    spanCount: spans.length,
    doneSpanCount,
    blockedSpanCount,
    unreviewedSpanCount,
    awaitingSecondApprovalCount,
    manifest,
    durationSeconds,
  };
}

export async function getPublicationEligibility(
  workspaceId: string
): Promise<PublicationEligibility> {
  const evaluation = await evaluateWorkspace(workspaceId);
  return {
    eligible: evaluation.eligible,
    spanCount: evaluation.spanCount,
    doneSpanCount: evaluation.doneSpanCount,
    blockedSpanCount: evaluation.blockedSpanCount,
    unreviewedSpanCount: evaluation.unreviewedSpanCount,
    awaitingSecondApprovalCount: evaluation.awaitingSecondApprovalCount,
  };
}

async function manifestMatchesPublication(
  publicationId: string,
  manifest: readonly ManifestEntry[]
): Promise<boolean> {
  const rows = await prisma.transcriptPublicationSpan.findMany({
    where: { publicationId },
    select: { spanId: true, revisionId: true },
  });

  if (rows.length !== manifest.length) return false;

  const published = new Map(rows.map((row) => [row.spanId, row.revisionId]));
  return manifest.every((entry) => published.get(entry.spanId) === entry.revisionId);
}

export interface PublishInput {
  catalogId: string;
  audioHash: string;
  userId: string;
}

export interface PublishResult {
  publicationId: string;
  status: "SUCCEEDED" | "ACTIVATING" | "FAILED";
  reused: boolean;
}

/**
 * Publish, or republish, the whole transcript.
 *
 * Completing the last approval only makes a transcript eligible. A curator or
 * catalog administrator decides that it is fit to be read, which is an
 * editorial statement about the whole text and cannot be made span by span.
 */
export async function publishTranscript(
  input: PublishInput
): Promise<PublishResult> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: {
      workflowGroupId: input.catalogId,
      audioHash: input.audioHash,
      status: "ACTIVE",
    },
    select: {
      id: true,
      workflowGroupId: true,
      audioHash: true,
      sourceBackend: true,
      sourceFingerprint: true,
      readerPublicationId: true,
      searchPublicationId: true,
    },
  });

  if (!workspace) {
    throw new CorrectionError(
      "NO_WORKSPACE",
      "Correction has not been started for this recording"
    );
  }

  await assertNoPublicationInFlight(workspace.id);

  const evaluation = await evaluateWorkspace(workspace.id);
  if (!evaluation.eligible) {
    throw new CorrectionError(
      "NOT_ELIGIBLE_FOR_PUBLICATION",
      "Every span needs two approvals and no objection before the transcript can be published",
      {
        spanCount: evaluation.spanCount,
        doneSpanCount: evaluation.doneSpanCount,
        blockedSpanCount: evaluation.blockedSpanCount,
      }
    );
  }

  // Restoring a reader pointer over text that has not moved renders and
  // indexes nothing: the snapshot search already carries is the same one.
  if (
    workspace.searchPublicationId &&
    (await manifestMatchesPublication(workspace.searchPublicationId, evaluation.manifest))
  ) {
    await prisma.transcriptWorkspace.update({
      where: { id: workspace.id },
      data: { readerPublicationId: workspace.searchPublicationId },
    });
    return {
      publicationId: workspace.searchPublicationId,
      status: "SUCCEEDED",
      reused: true,
    };
  }

  const guideRevisionId = await getActiveGuideRevisionId(input.catalogId);

  // The pending row is what locks the workspace, so the manifest is taken
  // after it exists rather than before: a decision landing in between would
  // otherwise be snapshotted from a workspace nobody was holding still.
  let publicationId: string;
  try {
    const publication = await prisma.transcriptPublication.create({
      data: {
        workspaceId: workspace.id,
        workflowGroupId: workspace.workflowGroupId,
        audioHash: workspace.audioHash,
        status: "PENDING",
        requiredApprovals: REQUIRED_APPROVALS,
        guideRevisionId,
        publishedById: input.userId,
        previousSourceKind: workspace.searchPublicationId ? "publication" : "machine",
        previousSourceRef: workspace.searchPublicationId ?? workspace.sourceBackend,
      },
      select: { id: true },
    });
    publicationId = publication.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new CorrectionError(
        "PUBLICATION_IN_FLIGHT",
        "A publication for this workspace is already running"
      );
    }
    throw error;
  }

  const locked = await evaluateWorkspace(workspace.id);
  if (!locked.eligible) {
    // Nothing references an empty pending row, so withdrawing it leaves no
    // trace of a publication that never had a manifest.
    await prisma.transcriptPublication.delete({ where: { id: publicationId } });
    throw new CorrectionError(
      "NOT_ELIGIBLE_FOR_PUBLICATION",
      "Every span needs two approvals and no objection before the transcript can be published",
      {
        spanCount: locked.spanCount,
        doneSpanCount: locked.doneSpanCount,
        blockedSpanCount: locked.blockedSpanCount,
      }
    );
  }

  await prisma.$transaction([
    prisma.transcriptPublicationSpan.createMany({
      data: locked.manifest.map((entry) => ({
        publicationId,
        spanId: entry.spanId,
        revisionId: entry.revisionId,
        ordinal: entry.ordinal,
      })),
    }),
    prisma.transcriptPublication.update({
      where: { id: publicationId },
      data: {
        spanCount: locked.manifest.length,
        durationSeconds: locked.durationSeconds,
      },
    }),
  ]);

  const status = await runPublicationJob(publicationId);
  return { publicationId, status, reused: false };
}

async function assertNoPublicationInFlight(workspaceId: string): Promise<void> {
  const inFlight = await prisma.transcriptPublication.findFirst({
    where: { workspaceId, status: { in: ["PENDING", "ACTIVATING"] } },
    select: { id: true },
  });
  if (inFlight) {
    throw new CorrectionError(
      "PUBLICATION_IN_FLIGHT",
      "A publication for this workspace is already running",
      { publicationId: inFlight.id }
    );
  }
}

/**
 * Materialize, render, hand the new text to the indexer, then move the
 * database pointers.
 *
 * The filesystem and PostgreSQL cannot form one transaction, so the order is
 * chosen: the only crash window leaves search holding the verified new
 * snapshot while database consumers still resolve the old one. That is the
 * safe direction — search may be newer than the reader, never the reverse.
 */
export async function runPublicationJob(
  publicationId: string
): Promise<"SUCCEEDED" | "ACTIVATING" | "FAILED"> {
  const publication = await prisma.transcriptPublication.findUnique({
    where: { id: publicationId },
    select: {
      id: true,
      status: true,
      workspaceId: true,
      workflowGroupId: true,
      audioHash: true,
      requiredApprovals: true,
      transcriptFingerprint: true,
      workspace: {
        select: { id: true, sourceBackend: true, sourceFingerprint: true },
      },
    },
  });

  if (!publication) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }

  if (publication.status === "ACTIVATING") {
    return reconcilePublication(publicationId);
  }
  if (publication.status !== "PENDING") {
    throw new CorrectionError(
      "PUBLICATION_NOT_FOUND",
      `Publication is ${publication.status} and cannot be run`
    );
  }

  await prisma.transcriptPublication.update({
    where: { id: publicationId },
    data: { attemptCount: { increment: 1 } },
  });

  let fingerprint: string;
  let jsonPath: string;
  try {
    const rendered = await materializeArtifacts(publication);
    fingerprint = rendered.fingerprint;
    jsonPath = rendered.jsonPath;
  } catch (error) {
    await failPublication(publicationId, error);
    return "FAILED";
  }

  // From here the workspace stays locked until the new text is verifiably the
  // effective search source, because a half-activated publication that
  // silently unlocked would let the next edit race the index.
  await prisma.transcriptPublication.update({
    where: { id: publicationId },
    data: {
      status: "ACTIVATING",
      transcriptFingerprint: fingerprint,
      activatingAt: new Date(),
    },
  });

  await writeIndexPointer({
    schema_version: INDEX_POINTER_SCHEMA_VERSION,
    workflow_group_id: publication.workflowGroupId,
    audio_hash: publication.audioHash,
    workspace_id: publication.workspaceId,
    publication_id: publication.id,
    state: "activating",
    backend: publication.workspace.sourceBackend,
    transcript_path: relativeToCorrectionsRoot(jsonPath),
    transcript_fingerprint: fingerprint,
    updated_at: new Date().toISOString(),
  });

  return reconcilePublication(publicationId);
}

/**
 * Finish an activation, whatever happened in between.
 *
 * Reconciliation asks one question — does the effective search source for this
 * audio hash carry the fingerprint this publication recorded? — and never
 * about the identity of a whole index bundle. Unrelated syncs therefore cannot
 * strand a workspace, and a rollback cannot discard their work.
 */
export async function reconcilePublication(
  publicationId: string
): Promise<"SUCCEEDED" | "ACTIVATING" | "FAILED"> {
  const publication = await prisma.transcriptPublication.findUnique({
    where: { id: publicationId },
    select: {
      id: true,
      status: true,
      workspaceId: true,
      workflowGroupId: true,
      audioHash: true,
      transcriptFingerprint: true,
      workspace: { select: { sourceBackend: true } },
    },
  });

  if (!publication) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }
  if (publication.status === "SUCCEEDED") return "SUCCEEDED";
  if (publication.status !== "ACTIVATING") {
    throw new CorrectionError(
      "PUBLICATION_NOT_FOUND",
      `Publication is ${publication.status} and cannot be reconciled`
    );
  }

  const expected = publication.transcriptFingerprint;
  if (!expected) {
    await failPublication(publicationId, new Error("Publication has no fingerprint"));
    return "FAILED";
  }

  let pointer = await readIndexPointer(
    publication.workflowGroupId,
    publication.audioHash
  );

  if (!pointer || pointer.transcript_fingerprint !== expected) {
    const jsonPath = resolvePublicationFilePath(
      publication.workflowGroupId,
      publication.workspaceId,
      publication.id,
      "json"
    );
    await writeIndexPointer({
      schema_version: INDEX_POINTER_SCHEMA_VERSION,
      workflow_group_id: publication.workflowGroupId,
      audio_hash: publication.audioHash,
      workspace_id: publication.workspaceId,
      publication_id: publication.id,
      state: "activating",
      backend: publication.workspace.sourceBackend,
      transcript_path: relativeToCorrectionsRoot(jsonPath),
      transcript_fingerprint: expected,
      updated_at: new Date().toISOString(),
    });
    pointer = await readIndexPointer(
      publication.workflowGroupId,
      publication.audioHash
    );
    if (!pointer || pointer.transcript_fingerprint !== expected) {
      return "ACTIVATING";
    }
  }

  await prisma.$transaction([
    prisma.transcriptWorkspace.update({
      where: { id: publication.workspaceId },
      data: {
        readerPublicationId: publication.id,
        searchPublicationId: publication.id,
      },
    }),
    prisma.transcriptPublication.update({
      where: { id: publication.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), errorCode: null, errorMessage: null },
    }),
  ]);

  await writeIndexPointer({ ...pointer, state: "active", updated_at: new Date().toISOString() });

  return "SUCCEEDED";
}

async function failPublication(
  publicationId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof CorrectionError ? error.code : "PUBLICATION_JOB_FAILED";

  await prisma.transcriptPublication.update({
    where: { id: publicationId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorCode: code.slice(0, 64),
      errorMessage: message.slice(0, 2000),
    },
  });
}

interface MaterializeTarget {
  id: string;
  workspaceId: string;
  workflowGroupId: string;
  audioHash: string;
  requiredApprovals: number;
  workspace: { sourceBackend: string; sourceFingerprint: string };
}

async function materializeArtifacts(
  publication: MaterializeTarget
): Promise<{ fingerprint: string; jsonPath: string }> {
  const source = await readJsonFile<CanonicalTranscript>(
    resolveWorkspaceSourcePath(publication.workflowGroupId, publication.workspaceId)
  );
  if (!source) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      "The frozen machine source for this workspace is missing"
    );
  }

  const rows = await prisma.transcriptPublicationSpan.findMany({
    where: { publicationId: publication.id },
    orderBy: { ordinal: "asc" },
    select: {
      ordinal: true,
      span: { select: { startSeconds: true, endSeconds: true } },
      revision: { select: { text: true } },
    },
  });

  if (rows.length === 0) {
    throw new CorrectionError(
      "NOT_ELIGIBLE_FOR_PUBLICATION",
      "The publication manifest is empty"
    );
  }

  const segments: RenderableSegment[] = rows.map((row) => ({
    start: row.span.startSeconds,
    end: row.span.endSeconds,
    text: row.revision.text,
  }));

  const document = materializeCorrectedTranscript({
    source,
    segments,
    provenance: {
      schema_version: CORRECTION_PROVENANCE_SCHEMA_VERSION,
      workspace_id: publication.workspaceId,
      publication_id: publication.id,
      source_fingerprint: publication.workspace.sourceFingerprint,
      published_at: new Date().toISOString(),
      required_approvals: publication.requiredApprovals,
    },
  });

  const json = `${JSON.stringify(document, null, 2)}\n`;
  const jsonPath = resolvePublicationFilePath(
    publication.workflowGroupId,
    publication.workspaceId,
    publication.id,
    "json"
  );

  await writeFileAtomic(jsonPath, json);
  await writeFileAtomic(
    resolvePublicationFilePath(
      publication.workflowGroupId,
      publication.workspaceId,
      publication.id,
      "txt"
    ),
    renderTxt(segments)
  );
  await writeFileAtomic(
    resolvePublicationFilePath(
      publication.workflowGroupId,
      publication.workspaceId,
      publication.id,
      "srt"
    ),
    renderSrt(segments)
  );
  await writeFileAtomic(
    resolvePublicationFilePath(
      publication.workflowGroupId,
      publication.workspaceId,
      publication.id,
      "vtt"
    ),
    renderVtt(segments)
  );

  return { fingerprint: fingerprintContent(json), jsonPath };
}

export interface UnpublishInput {
  catalogId: string;
  audioHash: string;
}

/**
 * Take the transcript off the reading surfaces without taking the corrections
 * out of search.
 *
 * One boolean could not express this, which is why the workspace carries two
 * pointers. Removing corrected text from search as well is a separate
 * administrative operation.
 */
export async function unpublishTranscript(
  input: UnpublishInput
): Promise<{ unpublished: boolean }> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: {
      workflowGroupId: input.catalogId,
      audioHash: input.audioHash,
      status: "ACTIVE",
    },
    select: { id: true, readerPublicationId: true },
  });

  if (!workspace) {
    throw new CorrectionError(
      "NO_WORKSPACE",
      "Correction has not been started for this recording"
    );
  }
  if (!workspace.readerPublicationId) {
    throw new CorrectionError(
      "NOT_PUBLISHED",
      "This transcript is not published"
    );
  }

  // Serialized rather than cancelling: a publication finishing afterwards
  // would otherwise move the reader pointer back and silently reverse this.
  await assertNoPublicationInFlight(workspace.id);

  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: { readerPublicationId: null },
  });

  return { unpublished: true };
}

/**
 * Remove corrected text from search as well.
 *
 * Deliberately not part of unpublish, and deliberately administrative: it
 * makes the machine transcript the effective search source again. It clears
 * the reader pointer too, because the one direction this system never allows
 * is a reader newer than search.
 */
export async function withdrawFromSearch(
  catalogId: string,
  audioHash: string
): Promise<void> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: { id: true, searchPublicationId: true },
  });
  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started");
  }

  await assertNoPublicationInFlight(workspace.id);
  await removeIndexPointer(catalogId, audioHash);
  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: { searchPublicationId: null, readerPublicationId: null },
  });
}

/**
 * Abandon an activation and put the previous effective source back for this
 * audio hash alone.
 */
export async function rollbackPublication(publicationId: string): Promise<void> {
  const publication = await prisma.transcriptPublication.findUnique({
    where: { id: publicationId },
    select: {
      id: true,
      status: true,
      workspaceId: true,
      workflowGroupId: true,
      audioHash: true,
      previousSourceKind: true,
      previousSourceRef: true,
      workspace: { select: { sourceBackend: true } },
    },
  });

  if (!publication) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }
  if (publication.status !== "ACTIVATING" && publication.status !== "PENDING") {
    throw new CorrectionError(
      "PUBLICATION_NOT_FOUND",
      `Publication is ${publication.status} and cannot be rolled back`
    );
  }

  if (publication.previousSourceKind === "publication" && publication.previousSourceRef) {
    const previous = await prisma.transcriptPublication.findUnique({
      where: { id: publication.previousSourceRef },
      select: { id: true, workspaceId: true, transcriptFingerprint: true },
    });
    if (previous?.transcriptFingerprint) {
      await writeIndexPointer({
        schema_version: INDEX_POINTER_SCHEMA_VERSION,
        workflow_group_id: publication.workflowGroupId,
        audio_hash: publication.audioHash,
        workspace_id: previous.workspaceId,
        publication_id: previous.id,
        state: "active",
        backend: publication.workspace.sourceBackend,
        transcript_path: relativeToCorrectionsRoot(
          resolvePublicationFilePath(
            publication.workflowGroupId,
            previous.workspaceId,
            previous.id,
            "json"
          )
        ),
        transcript_fingerprint: previous.transcriptFingerprint,
        updated_at: new Date().toISOString(),
      });
    }
  } else {
    await removeIndexPointer(publication.workflowGroupId, publication.audioHash);
  }

  await prisma.transcriptPublication.update({
    where: { id: publication.id },
    data: { status: "ROLLED_BACK", finishedAt: new Date() },
  });
}

export interface PublicationView {
  id: string;
  status: string;
  spanCount: number;
  durationSeconds: number;
  publishedById: string | null;
  transcriptFingerprint: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  isReaderPublication: boolean;
  isSearchPublication: boolean;
}

export async function listPublications(
  workspaceId: string,
  limit = 20
): Promise<PublicationView[]> {
  const [workspace, publications] = await Promise.all([
    prisma.transcriptWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { readerPublicationId: true, searchPublicationId: true },
    }),
    prisma.transcriptPublication.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        spanCount: true,
        durationSeconds: true,
        publishedById: true,
        transcriptFingerprint: true,
        createdAt: true,
        finishedAt: true,
        errorCode: true,
        errorMessage: true,
      },
    }),
  ]);

  return publications.map((publication) => ({
    ...publication,
    isReaderPublication: publication.id === workspace.readerPublicationId,
    isSearchPublication: publication.id === workspace.searchPublicationId,
  }));
}
