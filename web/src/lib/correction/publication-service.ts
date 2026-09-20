import {
  Prisma,
  type TranscriptPublicationStatus,
} from "@/generated/prisma/client";
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
  readTextFile,
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
import { lockWorkspace } from "@/lib/correction/workspace-lock";

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
  workspaceId: string,
  client: Prisma.TransactionClient = prisma
): Promise<WorkspaceEvaluation> {
  const spans = await client.transcriptSpan.findMany({
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
      : await client.transcriptSpanDecision.findMany({
          where: { revisionId: { in: revisionIds } },
          select: { spanId: true, actorKey: true, kind: true, createdAt: true },
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
  manifest: readonly ManifestEntry[],
  client: Prisma.TransactionClient = prisma
): Promise<boolean> {
  const rows = await client.transcriptPublicationSpan.findMany({
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

  const guideRevisionId = await getActiveGuideRevisionId(input.catalogId);

  // Everything that decides what this publication contains happens under the
  // workspace lock and in one transaction: the eligibility recheck, the
  // manifest and the pending row that locks out further writes. Splitting them
  // let a decision land between the check and the snapshot, and let a crash
  // leave a pending publication with no manifest holding the workspace shut.
  const prepared = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, existing.id);

      const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          id: true,
          workflowGroupId: true,
          audioHash: true,
          sourceBackend: true,
          readerPublicationId: true,
          searchPublicationId: true,
          searchWithdrawalAt: true,
          publications: {
            where: { status: { in: ["PENDING", "ACTIVATING"] } },
            select: { id: true },
            take: 1,
          },
        },
      });

      if (workspace.publications.length > 0) {
        throw new CorrectionError(
          "PUBLICATION_IN_FLIGHT",
          "A publication for this workspace is already running",
          { publicationId: workspace.publications[0].id }
        );
      }
      if (workspace.searchWithdrawalAt) {
        // Publishing now would write an index pointer that the unfinished
        // withdrawal removes when it resumes.
        throw new CorrectionError(
          "PUBLICATION_IN_FLIGHT",
          "A withdrawal from search is unfinished; complete it before publishing"
        );
      }

      const evaluation = await evaluateWorkspace(workspace.id, tx);
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
        (await manifestMatchesPublication(
          workspace.searchPublicationId,
          evaluation.manifest,
          tx
        ))
      ) {
        await tx.transcriptWorkspace.update({
          where: { id: workspace.id },
          data: { readerPublicationId: workspace.searchPublicationId },
        });
        return {
          kind: "reused" as const,
          publicationId: workspace.searchPublicationId,
        };
      }

      const publication = await tx.transcriptPublication.create({
        data: {
          workspaceId: workspace.id,
          workflowGroupId: workspace.workflowGroupId,
          audioHash: workspace.audioHash,
          status: "PENDING",
          requiredApprovals: REQUIRED_APPROVALS,
          guideRevisionId,
          publishedById: input.userId,
          spanCount: evaluation.manifest.length,
          durationSeconds: evaluation.durationSeconds,
          previousSourceKind: workspace.searchPublicationId ? "publication" : "machine",
          previousSourceRef: workspace.searchPublicationId ?? workspace.sourceBackend,
        },
        select: { id: true },
      });

      await tx.transcriptPublicationSpan.createMany({
        data: evaluation.manifest.map((entry) => ({
          publicationId: publication.id,
          spanId: entry.spanId,
          revisionId: entry.revisionId,
          ordinal: entry.ordinal,
        })),
      });

      return { kind: "prepared" as const, publicationId: publication.id };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );

  if (prepared.kind === "reused") {
    return {
      publicationId: prepared.publicationId,
      status: "SUCCEEDED",
      reused: true,
    };
  }

  const status = await runPublicationJob(prepared.publicationId);
  return { publicationId: prepared.publicationId, status, reused: false };
}

async function assertNoPublicationInFlight(
  workspaceId: string,
  client: Prisma.TransactionClient = prisma
): Promise<void> {
  const inFlight = await client.transcriptPublication.findFirst({
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
      artifactSha256: true,
      createdAt: true,
      workspace: {
        select: { id: true, sourceBackend: true, sourceFingerprint: true },
      },
    },
  });

  if (!publication) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }

  if (publication.status === "ACTIVATING") {
    return reconcilePublication(publicationId, publication.workspaceId);
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
    await failPublication(publicationId, publication.workspaceId, ["PENDING"], error);
    return "FAILED";
  }

  // From here the workspace stays locked until the new text is verifiably the
  // effective search source, because a half-activated publication that
  // silently unlocked would let the next edit race the index.
  //
  // The status transition and the pointer write happen together under the
  // workspace lock. Every mutation of that file does, so two operations can
  // never interleave into a pointer that names one publication and a database
  // that names another. The transition is conditional as well: a rollback may
  // have claimed this publication while the artifacts were being rendered.
  const claimed = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, publication.workspaceId);

    const transitioned = await tx.transcriptPublication.updateMany({
      where: { id: publicationId, status: "PENDING" },
      data: {
        status: "ACTIVATING",
        artifactSha256: fingerprint,
        activatingAt: new Date(),
      },
    });
    if (transitioned.count === 0) return false;

    await writeIndexPointer({
      schema_version: INDEX_POINTER_SCHEMA_VERSION,
      workflow_group_id: publication.workflowGroupId,
      audio_hash: publication.audioHash,
      workspace_id: publication.workspaceId,
      publication_id: publication.id,
      state: "activating",
      backend: publication.workspace.sourceBackend,
      transcript_path: relativeToCorrectionsRoot(jsonPath),
      artifact_sha256: fingerprint,
      updated_at: new Date().toISOString(),
    });

    return true;
  });

  if (!claimed) {
    const current = await prisma.transcriptPublication.findUniqueOrThrow({
      where: { id: publicationId },
      select: { status: true },
    });
    throw new CorrectionError(
      "PUBLICATION_NOT_FOUND",
      `Publication is ${current.status} and was not activated`
    );
  }

  return reconcilePublication(publicationId, publication.workspaceId);
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
  publicationId: string,
  workspaceId: string
): Promise<"SUCCEEDED" | "ACTIVATING" | "FAILED"> {
  const publication = await prisma.transcriptPublication.findUnique({
    where: { id: publicationId },
    select: { id: true, status: true, workspaceId: true, artifactSha256: true },
  });

  // A publication is addressed by id, but the caller was authorized for one
  // workspace. Answering "not found" rather than "not yours" keeps the id from
  // telling anyone whether it exists in some other catalog.
  if (!publication || publication.workspaceId !== workspaceId) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }
  if (publication.status === "SUCCEEDED") return "SUCCEEDED";
  if (publication.status !== "ACTIVATING") {
    throw new CorrectionError(
      "PUBLICATION_NOT_FOUND",
      `Publication is ${publication.status} and cannot be reconciled`
    );
  }
  if (!publication.artifactSha256) {
    await failPublication(
      publicationId,
      workspaceId,
      ["ACTIVATING"],
      new Error("Publication has no artifact hash to verify against")
    );
    return "FAILED";
  }

  // Everything below runs under the workspace lock, including the pointer
  // read and write: the status is re-read inside it, so a rollback that
  // claimed this publication while we were getting here cannot be resurrected
  // as SUCCEEDED, and the pointer cannot be rewritten underneath one.
  return prisma.$transaction(
    async (tx): Promise<"SUCCEEDED" | "ACTIVATING" | "FAILED"> => {
      await lockWorkspace(tx, workspaceId);

      const current = await tx.transcriptPublication.findUniqueOrThrow({
        where: { id: publicationId },
        select: {
          status: true,
          workflowGroupId: true,
          audioHash: true,
          artifactSha256: true,
          workspace: { select: { sourceBackend: true } },
        },
      });
      if (current.status === "SUCCEEDED") return "SUCCEEDED";
      if (current.status !== "ACTIVATING") {
        throw new CorrectionError(
          "PUBLICATION_NOT_FOUND",
          `Publication is ${current.status} and cannot be reconciled`
        );
      }

      const expected = current.artifactSha256;
      if (!expected) return "ACTIVATING";

      const jsonPath = resolvePublicationFilePath(
        current.workflowGroupId,
        workspaceId,
        publicationId,
        "json"
      );

      // The artifact itself has to match, not just the metadata beside it.
      // Comparing the database hash with the hash the database also wrote into
      // the pointer would prove only that the two agree with each other.
      const artifact = await readTextFile(jsonPath);
      if (artifact === null || fingerprintContent(artifact) !== expected) {
        throw new CorrectionError(
          "SOURCE_MISSING",
          "The published artifact is missing or does not match its recorded hash"
        );
      }

      let pointer = await readIndexPointer(current.workflowGroupId, current.audioHash);
      if (!pointer || pointer.artifact_sha256 !== expected) {
        await writeIndexPointer({
          schema_version: INDEX_POINTER_SCHEMA_VERSION,
          workflow_group_id: current.workflowGroupId,
          audio_hash: current.audioHash,
          workspace_id: workspaceId,
          publication_id: publicationId,
          state: "activating",
          backend: current.workspace.sourceBackend,
          transcript_path: relativeToCorrectionsRoot(jsonPath),
          artifact_sha256: expected,
          updated_at: new Date().toISOString(),
        });
        pointer = await readIndexPointer(current.workflowGroupId, current.audioHash);
        if (!pointer || pointer.artifact_sha256 !== expected) {
          return "ACTIVATING";
        }
      }

      await tx.transcriptWorkspace.update({
        where: { id: workspaceId },
        data: {
          readerPublicationId: publicationId,
          searchPublicationId: publicationId,
        },
      });
      const finished = await tx.transcriptPublication.updateMany({
        where: { id: publicationId, status: "ACTIVATING" },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (finished.count === 0) {
        throw new CorrectionError(
          "PUBLICATION_NOT_FOUND",
          "Publication left ACTIVATING while it was being reconciled"
        );
      }

      await writeIndexPointer({
        ...pointer,
        state: "active",
        updated_at: new Date().toISOString(),
      });

      return "SUCCEEDED";
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}

/**
 * Record a failure, but only against the state that failed.
 *
 * Rendering happens outside the workspace lock, so a rollback can claim the
 * publication while it runs. An unconditional update would then turn a
 * deliberate ROLLED_BACK into FAILED and lose what actually happened.
 */
async function failPublication(
  publicationId: string,
  workspaceId: string,
  expected: TranscriptPublicationStatus[],
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof CorrectionError ? error.code : "PUBLICATION_JOB_FAILED";

  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await tx.transcriptPublication.updateMany({
      where: { id: publicationId, status: { in: expected } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorCode: code.slice(0, 64),
        errorMessage: message.slice(0, 2000),
      },
    });
  });
}

interface MaterializeTarget {
  id: string;
  workspaceId: string;
  workflowGroupId: string;
  audioHash: string;
  requiredApprovals: number;
  createdAt: Date;
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
      // The publication's own timestamp, not the moment of rendering, so
      // re-materializing the same manifest produces the same bytes and the
      // artifact hash is a content identity rather than a clock reading.
      published_at: publication.createdAt.toISOString(),
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

  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, existing.id);

    const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: existing.id },
      select: {
        readerPublicationId: true,
        publications: {
          where: { status: { in: ["PENDING", "ACTIVATING"] } },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!workspace.readerPublicationId) {
      throw new CorrectionError(
        "NOT_PUBLISHED",
        "This transcript is not published"
      );
    }

    // Serialized rather than cancelling: a publication finishing afterwards
    // would otherwise move the reader pointer back and silently reverse this.
    if (workspace.publications.length > 0) {
      throw new CorrectionError(
        "PUBLICATION_IN_FLIGHT",
        "A publication for this workspace is already running",
        { publicationId: workspace.publications[0].id }
      );
    }

    await tx.transcriptWorkspace.update({
      where: { id: existing.id },
      data: { readerPublicationId: null },
    });
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
    select: { id: true, searchWithdrawalAt: true },
  });
  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started");
  }

  // Step one: commit the intent along with the pointers it releases. From here
  // the database names no correction while the index still serves one, which
  // is search ahead of the reader — the direction this design allows. The
  // intent also blocks publication, whose pointer step two would otherwise
  // delete.
  if (!workspace.searchWithdrawalAt) {
    await prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspace.id);
      await assertNoPublicationInFlight(workspace.id, tx);
      await tx.transcriptWorkspace.update({
        where: { id: workspace.id },
        data: {
          searchPublicationId: null,
          readerPublicationId: null,
          searchWithdrawalAt: new Date(),
        },
      });
    });
  }

  // Step two, under the lock so no publication can write a pointer across it.
  // A crash here leaves the intent committed and the operation resumable:
  // calling withdraw again picks up from this point.
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspace.id);
    await removeIndexPointer(catalogId, audioHash);
  });

  // Step three: the intent is spent.
  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: { searchWithdrawalAt: null },
  });
}

export async function rollbackPublication(
  publicationId: string,
  workspaceId: string
): Promise<void> {
  // Claiming the publication and restoring the pointer happen together under
  // the workspace lock, so a reconciliation cannot complete the publication
  // this is abandoning, and cannot rewrite the pointer afterwards.
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);

    const publication = await tx.transcriptPublication.findUnique({
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

    if (!publication || publication.workspaceId !== workspaceId) {
      throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
    }

    // Already rolled back: nothing to do, and nothing safe to redo. Repeating
    // the pointer restore would let a stale retry reach past a publication
    // that has succeeded since, removing its pointer or replacing it with this
    // one's predecessor while the database still names the newer one.
    //
    // Nor is the branch needed for repair. The status change and the pointer
    // restore are one transaction, so a crash before it commits leaves the
    // publication PENDING or ACTIVATING, and the retry comes back through the
    // ordinary path.
    if (publication.status === "ROLLED_BACK") return;

    if (publication.status !== "ACTIVATING" && publication.status !== "PENDING") {
      throw new CorrectionError(
        "PUBLICATION_NOT_FOUND",
        `Publication is ${publication.status} and cannot be rolled back`
      );
    }

    const claimed = await tx.transcriptPublication.updateMany({
      where: { id: publicationId, status: { in: ["PENDING", "ACTIVATING"] } },
      data: { status: "ROLLED_BACK", finishedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new CorrectionError(
        "PUBLICATION_NOT_FOUND",
        "Publication changed state while it was being rolled back"
      );
    }

    if (publication.previousSourceKind === "publication" && publication.previousSourceRef) {
      const previous = await tx.transcriptPublication.findUnique({
        where: { id: publication.previousSourceRef },
        select: { id: true, workspaceId: true, artifactSha256: true },
      });
      if (previous?.artifactSha256) {
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
          artifact_sha256: previous.artifactSha256,
          updated_at: new Date().toISOString(),
        });
      }
    } else {
      await removeIndexPointer(publication.workflowGroupId, publication.audioHash);
    }
  });
}

export interface PublicationView {
  id: string;
  status: string;
  spanCount: number;
  durationSeconds: number;
  publishedById: string | null;
  artifactSha256: string | null;
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
        artifactSha256: true,
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
