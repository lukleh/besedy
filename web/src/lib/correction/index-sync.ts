import { fetchJobsApi } from "@/lib/jobs-api/server";
import { correctionIndexJobSchema } from "@/lib/jobs-api/schemas";

/**
 * Asking the search index to catch up with a correction.
 *
 * ADR 0006: publication proves replacement in the active search scope before
 * readers see the text. The index is built by the Python pipeline on the host
 * worker, so the web application submits a job through the jobs API and waits
 * for the worker to report what the bundle holds; `completeIndexSync` in the
 * publication service consumes that report. Withdrawal from search and
 * rollback change what the index should hold too, so they use the same job.
 */
export type IndexSyncOperation = "publish" | "withdraw" | "rollback";

export interface IndexSyncRequest {
  catalogId: string;
  audioHash: string;
  operation: IndexSyncOperation;
  /** The publication (publish, rollback) or withdrawal generation (withdraw) */
  operationToken: string;
  requestedById?: string | null;
  /** Part of the job's idempotency key, so a retry is a new run rather than the failed one */
  attempt: number;
}

export type IndexSyncRequester = (request: IndexSyncRequest) => Promise<{ jobId: string }>;

export const requestIndexSync: IndexSyncRequester = async (request) => {
  const job = await fetchJobsApi(
    `/catalogs/${encodeURIComponent(request.catalogId)}/correction/index-sync/jobs`,
    {
      method: "POST",
      body: {
        audioHash: request.audioHash,
        operation: request.operation,
        operationToken: request.operationToken,
        requestedById: request.requestedById ?? null,
        attempt: request.attempt,
      },
      schema: correctionIndexJobSchema,
    }
  );
  return { jobId: job.id };
};

/** What the worker reports once the sync has run. */
export interface IndexSyncCompletion {
  catalogId: string;
  audioHash: string;
  operation: IndexSyncOperation;
  operationToken: string;
  status: "SUCCEEDED" | "FAILED";
  /** The bundle's transcript fingerprint for the recording after the sync */
  transcriptFingerprint?: string | null;
  /** The transcript path the bundle recorded, in the worker's view of the filesystem */
  transcriptPath?: string | null;
  indexDir?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}
