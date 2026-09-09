import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadRecording } from "@/lib/ingest/upload-client";

const INTAKE_ID = "cmf9abcdefghijklmnopqrstu";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readBlobText(blob: Blob): Promise<string> {
  // jsdom's Blob has no text(); FileReader is the portable way to read it.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function intakeDto(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE_ID,
    catalogId: "20260201_120000",
    catalogLabel: "Main",
    originalFilename: "talk.mp3",
    sizeBytes: 7,
    receivedBytes: 7,
    mimeType: "audio/mpeg",
    status: "QUEUED",
    jobId: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
    audioHash: null,
    errorCode: null,
    errorMessage: null,
    requestedBy: { id: "admin-1", name: "Admin", email: null },
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("uploadRecording", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the upload, sends sequential chunks and finalizes", async () => {
    const file = new File(["abcdefg"], "talk.mp3", { type: "audio/mpeg" });
    const chunkBodies: string[] = [];
    const progress: number[] = [];

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/admin/ingest/uploads") {
        expect(JSON.parse(String(init?.body))).toEqual({
          catalogId: "20260201_120000",
          filename: "talk.mp3",
          sizeBytes: 7,
          mimeType: "audio/mpeg",
        });
        return jsonResponse({ intakeId: INTAKE_ID, chunkSizeBytes: 3 }, 201);
      }
      const chunkMatch = target.match(/\/chunks\/(\d+)$/);
      if (chunkMatch) {
        chunkBodies.push(await readBlobText(init?.body as Blob));
        const index = Number(chunkMatch[1]);
        return jsonResponse({
          intakeId: INTAKE_ID,
          receivedBytes: Math.min(7, (index + 1) * 3),
          receivedChunks: index + 1,
        });
      }
      if (target.endsWith("/finalize")) {
        return jsonResponse({ intake: intakeDto() });
      }
      throw new Error(`unexpected request ${target}`);
    });

    const intake = await uploadRecording({
      catalogId: "20260201_120000",
      file,
      onProgress: (sent) => progress.push(sent),
    });

    expect(intake.status).toBe("QUEUED");
    expect(chunkBodies).toEqual(["abc", "def", "g"]);
    expect(progress).toEqual([0, 3, 6, 7]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("retries a chunk once on a server error", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });
    let chunkAttempts = 0;

    fetchMock.mockImplementation(async (url: string | URL) => {
      const target = String(url);
      if (target === "/api/admin/ingest/uploads") {
        return jsonResponse({ intakeId: INTAKE_ID, chunkSizeBytes: 10 }, 201);
      }
      if (target.includes("/chunks/0")) {
        chunkAttempts += 1;
        if (chunkAttempts === 1) {
          return jsonResponse({ error: "boom" }, 503);
        }
        return jsonResponse({ intakeId: INTAKE_ID, receivedBytes: 3, receivedChunks: 1 });
      }
      if (target.endsWith("/finalize")) {
        return jsonResponse({ intake: intakeDto({ sizeBytes: 3, receivedBytes: 3 }) });
      }
      throw new Error(`unexpected request ${target}`);
    });

    await uploadRecording({ catalogId: "20260201_120000", file });
    expect(chunkAttempts).toBe(2);
  });

  it("skips ahead when the server reports a later expected chunk index", async () => {
    const file = new File(["abcdef"], "talk.mp3", { type: "audio/mpeg" });
    const putIndices: number[] = [];

    fetchMock.mockImplementation(async (url: string | URL) => {
      const target = String(url);
      if (target === "/api/admin/ingest/uploads") {
        return jsonResponse({ intakeId: INTAKE_ID, chunkSizeBytes: 3 }, 201);
      }
      const chunkMatch = target.match(/\/chunks\/(\d+)$/);
      if (chunkMatch) {
        const index = Number(chunkMatch[1]);
        putIndices.push(index);
        if (index === 0) {
          // The first attempt was committed server-side; the retry sees a conflict.
          return jsonResponse({ error: "Unexpected chunk index", expectedIndex: 1 }, 409);
        }
        return jsonResponse({ intakeId: INTAKE_ID, receivedBytes: 6, receivedChunks: 2 });
      }
      if (target.endsWith("/finalize")) {
        return jsonResponse({ intake: intakeDto({ sizeBytes: 6, receivedBytes: 6 }) });
      }
      throw new Error(`unexpected request ${target}`);
    });

    await uploadRecording({ catalogId: "20260201_120000", file });
    expect(putIndices).toEqual([0, 1]);
  });

  it("aborts the upload when a chunk fails permanently", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });
    const methods: string[] = [];

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      methods.push(`${init?.method ?? "GET"} ${target}`);
      if (target === "/api/admin/ingest/uploads") {
        return jsonResponse({ intakeId: INTAKE_ID, chunkSizeBytes: 10 }, 201);
      }
      if (target.includes("/chunks/0")) {
        return jsonResponse({ error: "Unexpected chunk index" }, 409);
      }
      if (target === `/api/admin/ingest/uploads/${INTAKE_ID}`) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${target}`);
    });

    await expect(uploadRecording({ catalogId: "20260201_120000", file })).rejects.toThrow();
    expect(methods).toContain(`DELETE /api/admin/ingest/uploads/${INTAKE_ID}`);
    expect(methods.some((entry) => entry.endsWith("/finalize"))).toBe(false);
  });
});
