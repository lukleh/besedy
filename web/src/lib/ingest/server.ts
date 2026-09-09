import fs from "fs/promises";
import path from "path";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { syncCatalogGroup } from "@/lib/catalog-sync";
import { getUploadsDir } from "@/lib/config";
import { ingestJobSchema, type IngestJob } from "@/lib/jobs-api/schemas";
import {
  fetchJobsApi,
  JobsApiConfigurationError,
  JobsApiError,
} from "@/lib/jobs-api/server";
import { removeRecordingWebState } from "./removal";
import type { RecordingIntakeDto, RecordingIntakeStatus } from "./types";

export const INGEST_ALLOWED_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".webm",
  ".mp4",
  ".mkv",
]);

const DEFAULT_CHUNK_BYTES = 50 * 1000 * 1000;
const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1000 * 1000 * 1000;
const MAX_RECONCILED_JOBS = 10;
// Marker the worker puts in its failure message when the ingest itself finished
// but the completion callback could not be delivered; the JSON after it is the
// outcome that would have been reported.
const COMPLETION_REPORT_FAILED_MARKER = "completion_report_failed:";

export const INTAKE_INCLUDE = {
  workflowGroup: { select: { label: true } },
  requestedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.RecordingIntakeInclude;

export type IntakeRow = Prisma.RecordingIntakeGetPayload<{ include: typeof INTAKE_INCLUDE }>;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getIngestChunkBytes(): number {
  return positiveIntFromEnv("INGEST_CHUNK_BYTES", DEFAULT_CHUNK_BYTES);
}

export function getIngestMaxUploadBytes(): number {
  return positiveIntFromEnv("INGEST_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

export function getSafeAudioExtension(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return INGEST_ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

export function resolveIntakeIncomingDir(catalogId: string, intakeId: string): string {
  return path.join(getUploadsDir(), catalogId, "incoming", intakeId);
}

export function resolveIntakeFilePath(row: {
  workflowGroupId: string;
  id: string;
  storedFilename: string;
}): string {
  return path.join(resolveIntakeIncomingDir(row.workflowGroupId, row.id), row.storedFilename);
}

/**
 * Create the intake directory so that the host ingest worker (a different UID
 * than the web container) can later move the file out and create sibling
 * directories. `mkdir`'s mode is masked by the umask, so every level below the
 * uploads root is chmod'ed explicitly; levels owned by another user are left
 * alone.
 */
export async function ensureSharedIntakeDir(catalogId: string, intakeId: string): Promise<string> {
  const root = getUploadsDir();
  const dir = resolveIntakeIncomingDir(catalogId, intakeId);
  await fs.mkdir(dir, { recursive: true, mode: 0o777 });
  const relative = path.relative(root, dir).split(path.sep);
  let current = root;
  for (const segment of relative) {
    current = path.join(current, segment);
    await fs.chmod(current, 0o777).catch(() => undefined);
  }
  return dir;
}

export async function removeIntakeDir(catalogId: string, intakeId: string): Promise<void> {
  await fs.rm(resolveIntakeIncomingDir(catalogId, intakeId), { recursive: true, force: true });
}

/** Remove the incoming, accepted and rejected directories of one intake. */
export async function removeAllIntakeDirs(catalogId: string, intakeId: string): Promise<void> {
  const root = path.join(getUploadsDir(), catalogId);
  for (const bucket of ["incoming", "accepted", "rejected"]) {
    await fs.rm(path.join(root, bucket, intakeId), { recursive: true, force: true });
  }
}

export function serializeIntake(
  row: IntakeRow,
  extra?: { prefectStateName?: string | null }
): RecordingIntakeDto {
  return {
    id: row.id,
    catalogId: row.workflowGroupId,
    catalogLabel: row.workflowGroup?.label ?? null,
    originalFilename: row.originalFilename,
    sizeBytes: Number(row.expectedSizeBytes),
    receivedBytes: Number(row.receivedBytes),
    mimeType: row.mimeType,
    status: row.status,
    jobId: row.jobId,
    audioHash: row.audioHash,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    requestedBy: row.requestedBy
      ? { id: row.requestedBy.id, name: row.requestedBy.name, email: row.requestedBy.email }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    prefectStateName: extra?.prefectStateName ?? null,
  };
}

interface TerminalUpdate {
  status: RecordingIntakeStatus;
  audioHash?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Apply an update only if the row is still in the status this poll observed,
 * so a completion callback that landed in between is never overwritten.
 * Returns the fresh row either way.
 */
async function transitionIntake(
  row: IntakeRow,
  data: Prisma.RecordingIntakeUpdateManyMutationInput
): Promise<IntakeRow> {
  await prisma.recordingIntake.updateMany({
    where: { id: row.id, status: row.status },
    data,
  });
  const fresh = await prisma.recordingIntake.findUnique({
    where: { id: row.id },
    include: INTAKE_INCLUDE,
  });
  return fresh ?? row;
}

function terminalData(update: TerminalUpdate): Prisma.RecordingIntakeUpdateManyMutationInput {
  return {
    status: update.status,
    ...(update.audioHash !== undefined ? { audioHash: update.audioHash } : {}),
    errorCode: update.errorCode,
    errorMessage: update.errorMessage,
    finishedAt: new Date(),
  };
}

/**
 * Recover the outcome the worker could not deliver: its failure message carries
 * `completion_report_failed:{...json outcome...}`.
 */
export function parseUndeliveredOutcome(message: string | null | undefined): TerminalUpdate | null {
  if (!message) return null;
  const start = message.indexOf(COMPLETION_REPORT_FAILED_MARKER);
  if (start === -1) return null;
  const jsonStart = message.indexOf("{", start);
  const jsonEnd = message.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(message.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    const status = parsed.status;
    if (
      status !== "SUCCEEDED" &&
      status !== "REJECTED" &&
      status !== "FAILED" &&
      status !== "REMOVED"
    ) {
      return null;
    }
    return {
      status,
      audioHash: typeof parsed.audioHash === "string" ? parsed.audioHash.toLowerCase() : null,
      errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : null,
      errorMessage: typeof parsed.errorMessage === "string" ? parsed.errorMessage : null,
    };
  } catch {
    return null;
  }
}

/** Apply a terminal outcome the worker produced but could not deliver itself. */
async function applyOutcome(row: IntakeRow, outcome: TerminalUpdate): Promise<IntakeRow> {
  const updated = await transitionIntake(row, terminalData(outcome));
  if (outcome.status === "REMOVED") {
    await removeRecordingWebState(row.workflowGroupId, row.audioHash ?? outcome.audioHash ?? "");
    await syncCatalogGroup(row.workflowGroupId);
  } else if (outcome.status === "SUCCEEDED") {
    await syncCatalogGroup(row.workflowGroupId);
  }
  return updated;
}

async function applyJobState(row: IntakeRow, job: IngestJob): Promise<IntakeRow> {
  const removing = row.status === "REMOVING";
  if (job.status === "RUNNING") {
    return row.status === "QUEUED" ? transitionIntake(row, { status: "RUNNING" }) : row;
  }
  if (job.status === "QUEUED") {
    return row;
  }
  if (job.status === "CANCELLED") {
    return transitionIntake(
      row,
      terminalData({
        status: "CANCELLED",
        errorCode: "worker_cancelled",
        errorMessage: job.error_message ?? null,
      })
    );
  }
  if (job.status === "FAILED") {
    const undelivered = parseUndeliveredOutcome(job.error_message);
    if (undelivered) {
      return applyOutcome(row, undelivered);
    }
    return transitionIntake(
      row,
      terminalData({
        status: "FAILED",
        errorCode: removing ? "remove_failed" : "worker_failed",
        errorMessage: job.error_message ?? null,
      })
    );
  }
  // SUCCEEDED without a completion callback: the row was clobbered or the
  // callback was rejected. The work most likely completed, so finish the web
  // side (sync, or removal cleanup) and flag the gap for the operator.
  return applyOutcome(row, {
    status: removing ? "REMOVED" : "SUCCEEDED",
    audioHash: row.audioHash,
    errorCode: "completion_missing",
    errorMessage:
      "The worker finished but its completion report never arrived; the catalog was re-synced.",
  });
}

export interface ReconciledIntake {
  row: IntakeRow;
  prefectStateName: string | null;
}

/**
 * Overlay live Prefect state onto queued/running intakes. The worker reports
 * success/rejection itself; this catches crashes, cancellations and lost
 * callbacks so rows do not stay active forever.
 */
export async function reconcileActiveIntakes(rows: IntakeRow[]): Promise<ReconciledIntake[]> {
  const results: ReconciledIntake[] = rows.map((row) => ({ row, prefectStateName: null }));
  const active = results
    .filter(
      ({ row }) =>
        (row.status === "QUEUED" || row.status === "RUNNING" || row.status === "REMOVING") &&
        row.jobId
    )
    .slice(0, MAX_RECONCILED_JOBS);

  for (const entry of active) {
    const jobId = entry.row.jobId as string;
    let job: IngestJob;
    try {
      job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, { schema: ingestJobSchema });
    } catch (error) {
      if (error instanceof JobsApiConfigurationError) {
        return results;
      }
      if (error instanceof JobsApiError && error.status === 404) {
        entry.row = await transitionIntake(
          entry.row,
          terminalData({
            status: "FAILED",
            errorCode: "job_missing",
            errorMessage: "The ingest job no longer exists in Prefect.",
          })
        );
      }
      continue;
    }

    entry.prefectStateName = job.prefectStateName ?? null;
    entry.row = await applyJobState(entry.row, job);
  }

  return results;
}
