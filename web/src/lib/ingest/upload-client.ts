"use client";

import {
  ApiError,
  SchemaValidationError,
  fetchJson,
  redirectToSignIn,
} from "@/lib/api/fetch-json";
import {
  type ChunkUploadResponse,
  chunkUploadResponseSchema,
  createUploadResponseSchema,
  finalizeUploadResponseSchema,
  type RecordingIntakeDto,
} from "./types";

export interface UploadRecordingOptions {
  catalogId: string;
  file: File;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

const CHUNK_RETRY_LIMIT = 1;

function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500 && error.status < 600;
  }
  return error instanceof TypeError;
}

/**
 * The server tells a client that resends an already committed (or skipped)
 * index which chunk it expects next; resume from there instead of failing.
 */
function expectedIndexFromConflict(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const payload = error.payload;
  if (payload && typeof payload === "object" && "expectedIndex" in payload) {
    const value = (payload as { expectedIndex: unknown }).expectedIndex;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function parseJsonBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * PUT one chunk with XMLHttpRequest, because fetch reports no upload progress.
 * Errors mirror fetchJson: non-2xx responses become ApiError (with the parsed
 * payload, so 409 skip-ahead works) and network failures become TypeError.
 */
function putChunk(
  intakeId: string,
  index: number,
  blob: Blob,
  onSent: (loadedBytes: number) => void
): Promise<ChunkUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "PUT",
      `/api/admin/ingest/uploads/${encodeURIComponent(intakeId)}/chunks/${index}`
    );
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onSent(event.loaded);
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.onabort = () => reject(new TypeError("Network request aborted"));
    xhr.ontimeout = () => reject(new TypeError("Network request timed out"));
    xhr.onload = () => {
      const payload = parseJsonBody(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) {
          redirectToSignIn();
        }
        const message =
          (payload as { error?: string } | null)?.error ||
          xhr.statusText ||
          "Request failed";
        reject(new ApiError(message, xhr.status, payload));
        return;
      }
      const parsed = chunkUploadResponseSchema.safeParse(payload);
      if (!parsed.success) {
        reject(
          new SchemaValidationError("Invalid response payload", payload, parsed.error.issues)
        );
        return;
      }
      resolve(parsed.data);
    };
    xhr.send(blob);
  });
}

async function abortUpload(intakeId: string): Promise<void> {
  try {
    await fetch(`/api/admin/ingest/uploads/${encodeURIComponent(intakeId)}`, {
      method: "DELETE",
    });
  } catch {
    // Best effort: the server keeps the row as UPLOADING for manual cleanup.
  }
}

export async function finalizeUpload(intakeId: string): Promise<RecordingIntakeDto> {
  const finalized = await fetchJson(
    `/api/admin/ingest/uploads/${encodeURIComponent(intakeId)}/finalize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      schema: finalizeUploadResponseSchema,
    }
  );
  return finalized.intake;
}

/**
 * Upload one recording in sequential chunks and submit it for ingest.
 * Chunking keeps every request well under proxy body limits (Cloudflare caps
 * proxied uploads at 100 MB) while recordings routinely exceed that.
 */
export async function uploadRecording({
  catalogId,
  file,
  onProgress,
}: UploadRecordingOptions): Promise<RecordingIntakeDto> {
  const created = await fetchJson("/api/admin/ingest/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      catalogId,
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type || null,
    }),
    schema: createUploadResponseSchema,
  });

  const { intakeId, chunkSizeBytes } = created;
  const totalChunks = Math.ceil(file.size / chunkSizeBytes);
  const reportProgress = (sentBytes: number) =>
    onProgress?.(Math.min(sentBytes, file.size), file.size);
  reportProgress(0);

  let index = 0;
  try {
    while (index < totalChunks) {
      const offset = index * chunkSizeBytes;
      const blob = file.slice(offset, Math.min(offset + chunkSizeBytes, file.size));
      let attempt = 0;
      for (;;) {
        try {
          // Bytes the browser has sent, not bytes the server has stored yet.
          await putChunk(intakeId, index, blob, (loaded) =>
            reportProgress(offset + Math.min(loaded, blob.size))
          );
          index += 1;
          break;
        } catch (error) {
          const expectedIndex = expectedIndexFromConflict(error);
          if (expectedIndex !== null && expectedIndex > index && expectedIndex <= totalChunks) {
            // Our previous attempt was committed after all; skip ahead.
            index = expectedIndex;
            break;
          }
          if (attempt >= CHUNK_RETRY_LIMIT || !isRetryable(error)) {
            throw error;
          }
          attempt += 1;
          // The retry resends the whole chunk; never show more than is stored.
          reportProgress(offset);
        }
      }
      reportProgress(index * chunkSizeBytes);
    }

    return await finalizeUpload(intakeId);
  } catch (error) {
    // A 502 from finalize means the server kept (or already handled) the
    // upload; only unfinished chunk uploads are aborted.
    if (!(error instanceof ApiError && error.status === 502)) {
      await abortUpload(intakeId);
    }
    throw error;
  }
}
