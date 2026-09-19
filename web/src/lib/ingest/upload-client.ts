"use client";

import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import {
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

async function putChunk(intakeId: string, index: number, blob: Blob) {
  return fetchJson(
    `/api/admin/ingest/uploads/${encodeURIComponent(intakeId)}/chunks/${index}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
      schema: chunkUploadResponseSchema,
    }
  );
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
  onProgress?.(0, file.size);

  let index = 0;
  try {
    while (index < totalChunks) {
      const offset = index * chunkSizeBytes;
      const blob = file.slice(offset, Math.min(offset + chunkSizeBytes, file.size));
      let attempt = 0;
      for (;;) {
        try {
          await putChunk(intakeId, index, blob);
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
        }
      }
      onProgress?.(Math.min(index * chunkSizeBytes, file.size), file.size);
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
