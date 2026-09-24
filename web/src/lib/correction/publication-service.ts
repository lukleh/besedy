import { randomUUID } from "node:crypto";
import { Prisma, type TranscriptPublicationStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";
import { materializeCorrectedTranscript, CORRECTION_PROVENANCE_SCHEMA_VERSION } from "@/lib/correction/materialize";
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
import {
  requestIndexSync,
  type IndexSyncCompletion,
  type IndexSyncRequester,
} from "@/lib/correction/index-sync";

/**
 * Injection point for the search-index job. Routes use the jobs API; the
 * smoke check substitutes a recorder and drives completion by hand, because
 * the state machine is what it exercises, not Prefect.
 */
export interface PublicationDeps {
  indexSync?: IndexSyncRequester;
}

const MAX_ERROR_MESSAGE_LENGTH = 2000;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

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

const IN_FLIGHT_PUBLICATION_STATUSES: TranscriptPublicationStatus[] = ["PENDING", "ACTIVATING", "ROLLING_BACK"];

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

  const revisionIds = spans.map((span) => span.currentRevisionId).filter((id): id is string => id !== null);

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
    eligible: spans.length > 0 && doneSpanCount === spans.length && manifest.length === spans.length,
    spanCount: spans.length,
    doneSpanCount,
    blockedSpanCount,
    unreviewedSpanCount,
    awaitingSecondApprovalCount,
    manifest,
    durationSeconds,
  };
}

export async function getPublicationEligibility(workspaceId: string): Promise<PublicationEligibility> {
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
  input: PublishInput,
  deps: PublicationDeps = {}
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
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started for this recording");
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
          searchWithdrawalId: true,
          publications: {
            where: { status: { in: IN_FLIGHT_PUBLICATION_STATUSES } },
            select: { id: true },
            take: 1,
          },
        },
      });

      if (workspace.publications.length > 0) {
        throw new CorrectionError("PUBLICATION_IN_FLIGHT", "A publication for this workspace is already running", {
          publicationId: workspace.publications[0].id,
        });
      }
      if (workspace.searchWithdrawalId) {
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
        (await manifestMatchesPublication(workspace.searchPublicationId, evaluation.manifest, tx))
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

  const status = await runPublicationJob(prepared.publicationId, deps);
  return { publicationId: prepared.publicationId, status, reused: false };
}

async function assertNoPublicationInFlight(
  workspaceId: string,
  client: Prisma.TransactionClient = prisma
): Promise<void> {
  const inFlight = await client.transcriptPublication.findFirst({
    where: { workspaceId, status: { in: IN_FLIGHT_PUBLICATION_STATUSES } },
    select: { id: true },
  });
  if (inFlight) {
    throw new CorrectionError("PUBLICATION_IN_FLIGHT", "A publication for this workspace is already running", {
      publicationId: inFlight.id,
    });
  }
}

/**
 * Materialize, render, hand the new text to the indexer, then wait.
 *
 * The filesystem and PostgreSQL cannot form one transaction, so the order is
 * chosen: the artifacts and the index pointer exist before anything in the
 * database says the publication is live, and the database pointers move only
 * once the host worker has reported that the active search bundle carries
 * this publication's text (ADR 0006). Until then the publication is
 * ACTIVATING and the workspace stays locked.
 */
export async function runPublicationJob(
  publicationId: string,
  deps: PublicationDeps = {}
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
      attemptCount: true,
      publishedById: true,
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
    return reconcilePublication(publicationId, publication.workspaceId, deps);
  }
  if (publication.status !== "PENDING") {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", `Publication is ${publication.status} and cannot be run`);
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
    throw new CorrectionError("PUBLICATION_NOT_FOUND", `Publication is ${current.status} and was not activated`);
  }

  return requestPublicationIndexSync(
    {
      id: publication.id,
      workflowGroupId: publication.workflowGroupId,
      audioHash: publication.audioHash,
      publishedById: publication.publishedById,
      attempt: publication.attemptCount + 1,
      operation: "publish",
      expectedStatus: "ACTIVATING",
    },
    deps
  );
}

interface IndexSyncTarget {
  id: string;
  workflowGroupId: string;
  audioHash: string;
  publishedById: string | null;
  attempt: number;
  operation: "publish" | "rollback";
  expectedStatus: TranscriptPublicationStatus;
}

/**
 * Ask the host worker to carry this publication into the search index.
 *
 * A submission failure is recorded on the publication and leaves it where it
 * is: the artifacts and pointer are already on disk, so nothing is lost, and
 * reconciling later simply submits again. Failing the publication here would
 * throw away rendered work because the jobs API happened to be down.
 */
async function requestPublicationIndexSync(
  target: IndexSyncTarget,
  deps: PublicationDeps
): Promise<"ACTIVATING"> {
  const submit = deps.indexSync ?? requestIndexSync;
  try {
    const { jobId } = await submit({
      catalogId: target.workflowGroupId,
      audioHash: target.audioHash,
      operation: target.operation,
      operationToken: target.id,
      requestedById: target.publishedById,
      attempt: target.attempt,
    });
    await prisma.transcriptPublication.updateMany({
      where: { id: target.id, status: target.expectedStatus },
      data: {
        indexJobId: jobId,
        indexRequestedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
  } catch (error) {
    await prisma.transcriptPublication.updateMany({
      where: { id: target.id, status: target.expectedStatus },
      data: {
        errorCode: "INDEX_SYNC_SUBMIT_FAILED",
        errorMessage: errorText(error),
      },
    });
  }
  return "ACTIVATING";
}

/**
 * Finish an activation, whatever happened in between.
 *
 * Reconciliation asks one question — has the search side reported that the
 * active bundle carries this publication's text? — and never about the
 * identity of a whole index bundle. Until the report exists it asks the
 * worker again; once it does, it moves the database pointers. Unrelated syncs
 * therefore cannot strand a workspace, and a rollback cannot discard their
 * work.
 */
export async function reconcilePublication(
  publicationId: string,
  workspaceId: string,
  deps: PublicationDeps = {}
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
    throw new CorrectionError("PUBLICATION_NOT_FOUND", `Publication is ${publication.status} and cannot be reconciled`);
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
  const outcome = await prisma.$transaction(
    async (tx): Promise<"SUCCEEDED" | "ACTIVATING" | { resubmit: IndexSyncTarget }> => {
      await lockWorkspace(tx, workspaceId);

      const current = await tx.transcriptPublication.findUniqueOrThrow({
        where: { id: publicationId },
        select: {
          status: true,
          workflowGroupId: true,
          audioHash: true,
          artifactSha256: true,
          searchSourceFingerprint: true,
          attemptCount: true,
          publishedById: true,
          workspace: { select: { sourceBackend: true } },
        },
      });
      if (current.status === "SUCCEEDED") return "SUCCEEDED";
      if (current.status !== "ACTIVATING") {
        throw new CorrectionError("PUBLICATION_NOT_FOUND", `Publication is ${current.status} and cannot be reconciled`);
      }

      const expected = current.artifactSha256;
      if (!expected) return "ACTIVATING";

      const jsonPath = resolvePublicationFilePath(current.workflowGroupId, workspaceId, publicationId, "json");

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

      // No report from the search side yet: the pointer is in place, so ask
      // the worker (again) and keep waiting. A new attempt number makes the
      // request a new flow run rather than a failed one handed back.
      if (!current.searchSourceFingerprint) {
        await tx.transcriptPublication.update({
          where: { id: publicationId },
          data: { attemptCount: { increment: 1 } },
        });
        return {
          resubmit: {
            id: publicationId,
            workflowGroupId: current.workflowGroupId,
            audioHash: current.audioHash,
            publishedById: current.publishedById,
            attempt: current.attemptCount + 1,
            operation: "publish",
            expectedStatus: "ACTIVATING",
          },
        };
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
        throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication left ACTIVATING while it was being reconciled");
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

  if (typeof outcome === "string") return outcome;
  return requestPublicationIndexSync(outcome.resubmit, deps);
}

/**
 * The relative path under the corrections root, as both sides see it.
 *
 * The worker reports the transcript path in its own view of the filesystem,
 * which is mounted differently from the web container's, so paths are
 * compared by their tail under the corrections root rather than as a whole.
 */
function indexedPathMatches(reportedPath: string | null | undefined, expectedAbsolutePath: string): boolean {
  if (!reportedPath) return false;
  const relative = relativeToCorrectionsRoot(expectedAbsolutePath);
  const normalized = reportedPath.split("\\").join("/");
  return normalized === relative || normalized.endsWith(`/${relative}`);
}

function indexedPathIsCorrection(reportedPath: string | null | undefined, catalogId: string): boolean {
  if (!reportedPath) return false;
  return reportedPath.split("\\").join("/").includes(`corrections_${catalogId}/`);
}

export type IndexSyncOutcome =
  | "published"
  | "withdrawn"
  | "rolled_back"
  | "failure_recorded"
  | "source_mismatch"
  | "already_final"
  | "ignored";

/**
 * Consume the host worker's report about one index sync.
 *
 * This is the half of the protocol the ADR calls reconciliation: the report
 * says what the active bundle now holds for the recording, and the database
 * pointers move only if that is what the operation was supposed to leave
 * there. A report for a publication that has since been rolled back, or for a
 * withdrawal generation that has since completed, is ignored rather than
 * applied to the wrong state.
 */
export async function completeIndexSync(
  report: IndexSyncCompletion,
  deps: PublicationDeps = {}
): Promise<{ outcome: IndexSyncOutcome; detail?: string }> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: report.catalogId, audioHash: report.audioHash, status: "ACTIVE" },
    select: { id: true, searchWithdrawalId: true },
  });
  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started for this recording");
  }

  if (report.operation === "withdraw") {
    if (workspace.searchWithdrawalId !== report.operationToken) {
      return { outcome: "ignored", detail: "The withdrawal this report belongs to is no longer pending" };
    }
    if (report.status === "FAILED") {
      // The intent stays committed, so search still holds the correction the
      // reader has already released; the administrator reruns the withdrawal.
      return { outcome: "failure_recorded", detail: report.errorMessage ?? report.errorCode ?? undefined };
    }
    if (indexedPathIsCorrection(report.transcriptPath, report.catalogId)) {
      return {
        outcome: "source_mismatch",
        detail: `Search still holds a correction artifact: ${report.transcriptPath}`,
      };
    }
    await prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspace.id);
      await tx.transcriptWorkspace.updateMany({
        where: { id: workspace.id, status: "ACTIVE", searchWithdrawalId: report.operationToken },
        data: { searchWithdrawalId: null, searchWithdrawalJobId: null },
      });
    });
    return { outcome: "withdrawn" };
  }

  const publication = await prisma.transcriptPublication.findUnique({
    where: { id: report.operationToken },
    select: {
      id: true,
      status: true,
      workspaceId: true,
      workflowGroupId: true,
      previousSourceKind: true,
      previousSourceRef: true,
    },
  });
  if (!publication || publication.workspaceId !== workspace.id) {
    throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
  }

  if (report.operation === "publish") {
    if (publication.status === "SUCCEEDED") return { outcome: "already_final" };
    if (publication.status !== "ACTIVATING") {
      return { outcome: "ignored", detail: `Publication is ${publication.status}` };
    }
    if (report.status === "FAILED") {
      await prisma.transcriptPublication.updateMany({
        where: { id: publication.id, status: "ACTIVATING" },
        data: {
          errorCode: (report.errorCode ?? "INDEX_SYNC_FAILED").slice(0, 64),
          errorMessage: (report.errorMessage ?? "The search index sync failed").slice(0, MAX_ERROR_MESSAGE_LENGTH),
        },
      });
      return { outcome: "failure_recorded" };
    }
    const expectedPath = resolvePublicationFilePath(
      publication.workflowGroupId,
      publication.workspaceId,
      publication.id,
      "json"
    );
    if (!report.transcriptFingerprint || !indexedPathMatches(report.transcriptPath, expectedPath)) {
      await prisma.transcriptPublication.updateMany({
        where: { id: publication.id, status: "ACTIVATING" },
        data: {
          errorCode: "INDEX_SOURCE_MISMATCH",
          errorMessage: `Search indexed ${report.transcriptPath ?? "no source"} for this recording, not this publication`.slice(
            0,
            MAX_ERROR_MESSAGE_LENGTH
          ),
        },
      });
      return { outcome: "source_mismatch", detail: report.transcriptPath ?? undefined };
    }
    await prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspace.id);
      await tx.transcriptPublication.updateMany({
        where: { id: publication.id, status: "ACTIVATING" },
        data: {
          searchSourceFingerprint: report.transcriptFingerprint,
          searchSourcePath: report.transcriptPath ?? null,
        },
      });
    });
    const status = await reconcilePublication(publication.id, workspace.id, deps);
    return { outcome: status === "SUCCEEDED" ? "published" : "ignored", detail: status };
  }

  // rollback
  if (publication.status === "ROLLED_BACK") return { outcome: "already_final" };
  if (publication.status !== "ROLLING_BACK") {
    return { outcome: "ignored", detail: `Publication is ${publication.status}` };
  }
  if (report.status === "FAILED") {
    await prisma.transcriptPublication.updateMany({
      where: { id: publication.id, status: "ROLLING_BACK" },
      data: {
        errorCode: (report.errorCode ?? "INDEX_SYNC_FAILED").slice(0, 64),
        errorMessage: (report.errorMessage ?? "The search index sync failed").slice(0, MAX_ERROR_MESSAGE_LENGTH),
      },
    });
    return { outcome: "failure_recorded" };
  }
  let restored: boolean;
  if (publication.previousSourceKind === "publication" && publication.previousSourceRef) {
    const previous = await prisma.transcriptPublication.findUnique({
      where: { id: publication.previousSourceRef },
      select: { id: true, workspaceId: true, workflowGroupId: true },
    });
    restored =
      previous !== null &&
      indexedPathMatches(
        report.transcriptPath,
        resolvePublicationFilePath(previous.workflowGroupId, previous.workspaceId, previous.id, "json")
      );
  } else {
    restored = !indexedPathIsCorrection(report.transcriptPath, report.catalogId);
  }
  if (!restored) {
    await prisma.transcriptPublication.updateMany({
      where: { id: publication.id, status: "ROLLING_BACK" },
      data: {
        errorCode: "INDEX_SOURCE_MISMATCH",
        errorMessage: `Search indexed ${report.transcriptPath ?? "no source"}, not the previous source`.slice(
          0,
          MAX_ERROR_MESSAGE_LENGTH
        ),
      },
    });
    return { outcome: "source_mismatch", detail: report.transcriptPath ?? undefined };
  }
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspace.id);
    await tx.transcriptPublication.updateMany({
      where: { id: publication.id, status: "ROLLING_BACK" },
      data: { status: "ROLLED_BACK", finishedAt: new Date(), errorCode: null, errorMessage: null },
    });
  });
  return { outcome: "rolled_back" };
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
  const code = error instanceof CorrectionError ? error.code : "PUBLICATION_JOB_FAILED";

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
    throw new CorrectionError("SOURCE_MISSING", "The frozen machine source for this workspace is missing");
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
    throw new CorrectionError("NOT_ELIGIBLE_FOR_PUBLICATION", "The publication manifest is empty");
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
    resolvePublicationFilePath(publication.workflowGroupId, publication.workspaceId, publication.id, "txt"),
    renderTxt(segments)
  );
  await writeFileAtomic(
    resolvePublicationFilePath(publication.workflowGroupId, publication.workspaceId, publication.id, "srt"),
    renderSrt(segments)
  );
  await writeFileAtomic(
    resolvePublicationFilePath(publication.workflowGroupId, publication.workspaceId, publication.id, "vtt"),
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
export async function unpublishTranscript(input: UnpublishInput): Promise<{ unpublished: boolean }> {
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

  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, existing.id);

    const workspace = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: existing.id },
      select: {
        readerPublicationId: true,
        publications: {
          where: { status: { in: IN_FLIGHT_PUBLICATION_STATUSES } },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!workspace.readerPublicationId) {
      throw new CorrectionError("NOT_PUBLISHED", "This transcript is not published");
    }

    // Serialized rather than cancelling: a publication finishing afterwards
    // would otherwise move the reader pointer back and silently reverse this.
    if (workspace.publications.length > 0) {
      throw new CorrectionError("PUBLICATION_IN_FLIGHT", "A publication for this workspace is already running", {
        publicationId: workspace.publications[0].id,
      });
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
 * is a reader newer than search. The intent stays committed until the host
 * worker reports that the index holds the machine text again; a repeated call
 * resumes the same generation.
 */
export async function withdrawFromSearch(
  catalogId: string,
  audioHash: string,
  deps: PublicationDeps = {}
): Promise<void> {
  const workspace = await prisma.transcriptWorkspace.findFirst({
    where: { workflowGroupId: catalogId, audioHash, status: "ACTIVE" },
    select: { id: true },
  });
  if (!workspace) {
    throw new CorrectionError("NO_WORKSPACE", "Correction has not been started");
  }

  // Step one: claim or join one durable withdrawal generation. The token is
  // important: a delayed retry from an earlier withdrawal must not remove a
  // pointer written after that withdrawal completed, nor clear a later
  // withdrawal's intent.
  const withdrawalId = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspace.id);

    const current = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { status: true, searchWithdrawalId: true },
    });
    if (current.status !== "ACTIVE") {
      throw new CorrectionError("WORKSPACE_ARCHIVED", "This correction workspace has been archived");
    }
    if (current.searchWithdrawalId) return current.searchWithdrawalId;

    await assertNoPublicationInFlight(workspace.id, tx);
    const id = randomUUID();
    await tx.transcriptWorkspace.update({
      where: { id: workspace.id },
      data: {
        searchPublicationId: null,
        readerPublicationId: null,
        searchWithdrawalId: id,
      },
    });
    return id;
  });

  // Step two: remove the pointer only if this exact generation still owns the
  // intent. Another caller may already have completed it and allowed a new
  // publication to start while this request was waiting for the lock.
  const removed = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspace.id);

    const current = await tx.transcriptWorkspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { status: true, searchWithdrawalId: true },
    });
    if (current.status !== "ACTIVE" || current.searchWithdrawalId !== withdrawalId) {
      return false;
    }

    await removeIndexPointer(catalogId, audioHash);
    return true;
  });
  if (!removed) return;

  // Step three: ask the search side to drop the corrected chunks. The intent
  // is spent by `completeIndexSync` when the worker reports that the bundle
  // holds the machine text again, never here, so a crash or a failed sync
  // leaves search ahead of the reader — the allowed direction — and a rerun
  // of this operation resubmits the same generation.
  const submit = deps.indexSync ?? requestIndexSync;
  let jobId: string;
  try {
    ({ jobId } = await submit({
      catalogId,
      audioHash,
      operation: "withdraw",
      operationToken: withdrawalId,
      attempt: Math.floor(Date.now() / 1000),
    }));
  } catch (error) {
    throw new CorrectionError(
      "INDEX_SYNC_UNAVAILABLE",
      `The withdrawal is recorded, but the search index could not be asked to follow: ${errorText(error)}. Run it again to resubmit.`
    );
  }
  await prisma.transcriptWorkspace.updateMany({
    where: { id: workspace.id, status: "ACTIVE", searchWithdrawalId: withdrawalId },
    data: { searchWithdrawalJobId: jobId },
  });
}

export async function rollbackPublication(
  publicationId: string,
  workspaceId: string,
  deps: PublicationDeps = {}
): Promise<void> {
  // Step one: commit the rollback intent before touching the filesystem. Web
  // resolution stops preferring the abandoned ACTIVATING publication at this
  // point, while the index pointer may still name it. That is the allowed crash
  // direction: search can be newer than the reader, never the reverse.
  const target = await prisma.$transaction(async (tx) => {
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
        attemptCount: true,
        publishedById: true,
        workspace: { select: { sourceBackend: true } },
      },
    });

    if (!publication || publication.workspaceId !== workspaceId) {
      throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication not found");
    }

    // A completed rollback is a true no-op. Repeating its pointer restore could
    // otherwise reach past a newer successful publication.
    if (publication.status === "ROLLED_BACK") return null;

    if (publication.status === "ROLLING_BACK") return publication;

    if (publication.status !== "ACTIVATING" && publication.status !== "PENDING") {
      throw new CorrectionError(
        "PUBLICATION_NOT_FOUND",
        `Publication is ${publication.status} and cannot be rolled back`
      );
    }

    const claimed = await tx.transcriptPublication.updateMany({
      where: { id: publicationId, status: { in: ["PENDING", "ACTIVATING"] } },
      data: { status: "ROLLING_BACK", finishedAt: null },
    });
    if (claimed.count === 0) {
      throw new CorrectionError("PUBLICATION_NOT_FOUND", "Publication changed state while it was being rolled back");
    }

    return publication;
  });
  if (!target) return;

  // Step two: restore the previous effective source while the durable intent
  // blocks publication and workspace writes. Repeating this step is safe; a
  // crash leaves ROLLING_BACK committed and the next call resumes here.
  const restored = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);

    const current = await tx.transcriptPublication.findUniqueOrThrow({
      where: { id: publicationId },
      select: { status: true },
    });
    if (current.status === "ROLLED_BACK") return false;
    if (current.status !== "ROLLING_BACK") {
      throw new CorrectionError("PUBLICATION_NOT_FOUND", `Publication is ${current.status} and cannot finish rollback`);
    }

    if (target.previousSourceKind === "publication" && target.previousSourceRef) {
      const previous = await tx.transcriptPublication.findUnique({
        where: { id: target.previousSourceRef },
        select: { id: true, workspaceId: true, artifactSha256: true },
      });
      if (!previous?.artifactSha256) {
        throw new CorrectionError("SOURCE_MISSING", "The previous publication needed for rollback is unavailable");
      }
      await writeIndexPointer({
        schema_version: INDEX_POINTER_SCHEMA_VERSION,
        workflow_group_id: target.workflowGroupId,
        audio_hash: target.audioHash,
        workspace_id: previous.workspaceId,
        publication_id: previous.id,
        state: "active",
        backend: target.workspace.sourceBackend,
        transcript_path: relativeToCorrectionsRoot(
          resolvePublicationFilePath(target.workflowGroupId, previous.workspaceId, previous.id, "json")
        ),
        artifact_sha256: previous.artifactSha256,
        updated_at: new Date().toISOString(),
      });
    } else {
      await removeIndexPointer(target.workflowGroupId, target.audioHash);
    }

    return true;
  });
  if (!restored) return;

  // Step three: ask the search side to follow the restored pointer. The
  // publication becomes ROLLED_BACK in `completeIndexSync`, once the worker
  // reports that the bundle holds the previous source again; a stale retry of
  // a finished rollback sees ROLLED_BACK above and does nothing.
  const attempt = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const bumped = await tx.transcriptPublication.update({
      where: { id: publicationId },
      data: { attemptCount: { increment: 1 } },
      select: { attemptCount: true },
    });
    return bumped.attemptCount;
  });
  await requestPublicationIndexSync(
    {
      id: publicationId,
      workflowGroupId: target.workflowGroupId,
      audioHash: target.audioHash,
      publishedById: target.publishedById,
      attempt,
      operation: "rollback",
      expectedStatus: "ROLLING_BACK",
    },
    deps
  );
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
  indexJobId: string | null;
  searchSourceFingerprint: string | null;
  isReaderPublication: boolean;
  isSearchPublication: boolean;
}

export async function listPublications(workspaceId: string, limit = 20): Promise<PublicationView[]> {
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
        indexJobId: true,
        searchSourceFingerprint: true,
      },
    }),
  ]);

  return publications.map((publication) => ({
    ...publication,
    isReaderPublication: publication.id === workspace.readerPublicationId,
    isSearchPublication: publication.id === workspace.searchPublicationId,
  }));
}
