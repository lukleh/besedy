import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadRecording } from "@/lib/ingest/upload-client";
import { notifyWebVersionObserver } from "@/lib/service-worker/runtime";

vi.mock("@/lib/service-worker/runtime", () => ({
  notifyWebVersionObserver: vi.fn(),
}));

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

type ChunkHandler = (xhr: FakeXhr, index: number, body: Blob) => void | Promise<void>;

/**
 * Chunk PUTs go through XMLHttpRequest for upload progress; the other requests
 * still use fetch. Each test answers chunks through `chunkHandler`.
 */
let chunkHandler: ChunkHandler = () => {
  throw new Error("no chunk handler");
};
// Errors thrown by a handler (including failed expectations) are kept here and
// rethrown after the upload, so a retry can never hide them.
let handlerErrors: unknown[] = [];

class FakeXhr {
  method = "";
  url = "";
  status = 0;
  statusText = "";
  responseText = "";
  requestHeaders: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body: Blob) {
    const match = this.url.match(/\/chunks\/(\d+)$/);
    if (!match) throw new Error(`unexpected XHR ${this.method} ${this.url}`);
    void Promise.resolve()
      .then(() => chunkHandler(this, Number(match[1]), body))
      .catch((error: unknown) => {
        handlerErrors.push(error);
        this.fail();
      });
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name] ?? null;
  }

  progress(loaded: number) {
    this.upload.onprogress?.({ loaded });
  }

  respond(payload: unknown, status = 200) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }
}

function chunkAccepted(index: number, receivedBytes: number) {
  return { intakeId: INTAKE_ID, receivedBytes, receivedChunks: index + 1 };
}

describe("uploadRecording", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let createBodies: unknown[];

  beforeEach(() => {
    fetchMock = vi.fn();
    createBodies = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.mocked(notifyWebVersionObserver).mockClear();
    handlerErrors = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chunkHandler = () => {
      throw new Error("no chunk handler");
    };
    const errors = handlerErrors;
    handlerErrors = [];
    if (errors.length > 0) throw errors[0];
  });

  function mockFetch(chunkSizeBytes: number, finalized = intakeDto()) {
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/admin/ingest/uploads") {
        createBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ intakeId: INTAKE_ID, chunkSizeBytes }, 201);
      }
      if (target.endsWith("/finalize")) {
        return jsonResponse({ intake: finalized });
      }
      if (target === `/api/admin/ingest/uploads/${INTAKE_ID}` && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${target}`);
    });
  }

  it("creates the upload, sends sequential chunks and finalizes", async () => {
    const file = new File(["abcdefg"], "talk.mp3", { type: "audio/mpeg" });
    const chunkBodies: string[] = [];
    const progress: number[] = [];

    mockFetch(3);
    chunkHandler = async (xhr, index, body) => {
      expect(xhr.method).toBe("PUT");
      expect(xhr.requestHeaders["Content-Type"]).toBe("application/octet-stream");
      chunkBodies.push(await readBlobText(body));
      xhr.respond(chunkAccepted(index, Math.min(7, (index + 1) * 3)));
    };

    const intake = await uploadRecording({
      catalogId: "20260201_120000",
      file,
      onProgress: (sent) => progress.push(sent),
    });

    expect(createBodies).toEqual([{
      catalogId: "20260201_120000",
      filename: "talk.mp3",
      sizeBytes: 7,
      mimeType: "audio/mpeg",
    }]);
    expect(intake.status).toBe("QUEUED");
    expect(chunkBodies).toEqual(["abc", "def", "g"]);
    expect(progress).toEqual([0, 3, 6, 7]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports progress inside each chunk as the browser sends it", async () => {
    const file = new File(["abcdefg"], "talk.mp3", { type: "audio/mpeg" });
    const progress: number[] = [];

    mockFetch(3);
    chunkHandler = (xhr, index, body) => {
      xhr.progress(1);
      xhr.progress(body.size);
      xhr.respond(chunkAccepted(index, Math.min(7, (index + 1) * 3)));
    };

    await uploadRecording({
      catalogId: "20260201_120000",
      file,
      onProgress: (sent) => progress.push(sent),
    });

    expect(progress).toEqual([0, 1, 3, 3, 4, 6, 6, 7, 7, 7]);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });

  it("retries a chunk once on a server error", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });
    let chunkAttempts = 0;

    mockFetch(10, intakeDto({ sizeBytes: 3, receivedBytes: 3 }));
    chunkHandler = (xhr, index) => {
      chunkAttempts += 1;
      if (chunkAttempts === 1) {
        xhr.respond({ error: "boom" }, 503);
        return;
      }
      xhr.respond(chunkAccepted(index, 3));
    };

    await uploadRecording({ catalogId: "20260201_120000", file });
    expect(chunkAttempts).toBe(2);
  });

  it("retries after a network error and restarts progress at the chunk start", async () => {
    const file = new File(["abcdef"], "talk.mp3", { type: "audio/mpeg" });
    const progress: number[] = [];
    let chunk1Attempts = 0;

    mockFetch(3, intakeDto({ sizeBytes: 6, receivedBytes: 6 }));
    chunkHandler = (xhr, index) => {
      if (index === 1) {
        chunk1Attempts += 1;
        if (chunk1Attempts === 1) {
          xhr.progress(2);
          xhr.fail();
          return;
        }
        xhr.progress(1);
      }
      xhr.respond(chunkAccepted(index, (index + 1) * 3));
    };

    await uploadRecording({
      catalogId: "20260201_120000",
      file,
      onProgress: (sent) => progress.push(sent),
    });

    expect(chunk1Attempts).toBe(2);
    expect(progress).toEqual([0, 3, 5, 3, 4, 6]);
  });

  it("skips ahead when the server reports a later expected chunk index", async () => {
    const file = new File(["abcdef"], "talk.mp3", { type: "audio/mpeg" });
    const putIndices: number[] = [];

    mockFetch(3, intakeDto({ sizeBytes: 6, receivedBytes: 6 }));
    chunkHandler = (xhr, index) => {
      putIndices.push(index);
      if (index === 0) {
        // The first attempt was committed server-side; the retry sees a conflict.
        xhr.respond({ error: "Unexpected chunk index", expectedIndex: 1 }, 409);
        return;
      }
      xhr.respond(chunkAccepted(index, 6));
    };

    await uploadRecording({ catalogId: "20260201_120000", file });
    expect(putIndices).toEqual([0, 1]);
  });

  it("aborts the upload when a chunk fails permanently", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });

    mockFetch(10);
    chunkHandler = (xhr) => {
      xhr.respond({ error: "Unexpected chunk index" }, 409);
    };

    await expect(uploadRecording({ catalogId: "20260201_120000", file })).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "Unexpected chunk index",
    });
    const requests = fetchMock.mock.calls.map(
      ([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`
    );
    expect(requests).toContain(`DELETE /api/admin/ingest/uploads/${INTAKE_ID}`);
    expect(requests.some((entry) => entry.endsWith("/finalize"))).toBe(false);
  });

  it("rejects a chunk response that does not match the schema", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });

    mockFetch(10);
    chunkHandler = (xhr) => {
      xhr.respond({ unexpected: true });
    };

    await expect(uploadRecording({ catalogId: "20260201_120000", file })).rejects.toMatchObject({
      name: "SchemaValidationError",
    });
  });

  it("reports the deployed web version from chunk responses", async () => {
    const file = new File(["abc"], "talk.mp3", { type: "audio/mpeg" });

    mockFetch(10, intakeDto({ sizeBytes: 3, receivedBytes: 3 }));
    chunkHandler = (xhr, index) => {
      xhr.responseHeaders["X-Web-Version"] = "web-vnext";
      xhr.respond(chunkAccepted(index, 3));
    };

    await uploadRecording({ catalogId: "20260201_120000", file });
    expect(notifyWebVersionObserver).toHaveBeenCalledWith("web-vnext");
  });
});
