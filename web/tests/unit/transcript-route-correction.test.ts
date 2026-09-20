import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getTranscript } from "@/app/api/transcript/[hash]/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return { ...actual, requireAuth: vi.fn() };
});

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveActiveGroup: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
  logTranscriptViewed: vi.fn(),
}));

vi.mock("@/lib/transcript", () => ({
  getAvailableTranscripts: vi.fn(),
  loadTranscript: vi.fn(),
}));

vi.mock("@/lib/transcript-priority", () => ({
  listTranscriptBackendPriorities: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

vi.mock("@/lib/correction/resolve", () => ({
  resolveReaderTranscriptSource: vi.fn(),
}));

vi.mock("@/lib/correction/reader-transcript", () => ({
  getReaderCorrectionState: vi.fn(),
  loadPublishedTranscript: vi.fn(),
}));

const VALID_HASH = "a".repeat(64);
const MACHINE_BACKEND = "faster-whisper/large-v3@silero_vad_v6";
const CORRECTED = "corrected/published";

const PROGRESS = {
  started: true,
  spanCount: 120,
  totalDurationSeconds: 3600,
  reviewedOnceDurationSeconds: 1800,
  fullyApprovedDurationSeconds: 900,
  reviewedOnceRatio: 0.5,
  fullyApprovedRatio: 0.25,
};

function request(backend?: string): NextRequest {
  const suffix = backend ? `?backend=${encodeURIComponent(backend)}` : "";
  return new NextRequest(`http://localhost/api/transcript/${VALID_HASH}${suffix}`);
}

function call(backend?: string) {
  return getTranscript(request(backend), {
    params: Promise.resolve({ hash: VALID_HASH }),
  });
}

describe("transcript route under the publication gate", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
  let getAvailableTranscripts: ReturnType<typeof vi.fn>;
  let loadTranscript: ReturnType<typeof vi.fn>;
  let listTranscriptBackendPriorities: ReturnType<typeof vi.fn>;
  let resolveReaderTranscriptSource: ReturnType<typeof vi.fn>;
  let getReaderCorrectionState: ReturnType<typeof vi.fn>;
  let loadPublishedTranscript: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions"))
      .requireAuth as ReturnType<typeof vi.fn>;
    getRecordingCapability = (await import("@/lib/access/capabilities"))
      .getRecordingCapability as ReturnType<typeof vi.fn>;
    resolveActiveGroup = (await import("@/lib/catalog/resolve-group"))
      .resolveActiveGroup as ReturnType<typeof vi.fn>;
    const transcriptModule = await import("@/lib/transcript");
    getAvailableTranscripts = transcriptModule.getAvailableTranscripts as ReturnType<
      typeof vi.fn
    >;
    loadTranscript = transcriptModule.loadTranscript as ReturnType<typeof vi.fn>;
    listTranscriptBackendPriorities = (await import("@/lib/transcript-priority"))
      .listTranscriptBackendPriorities as ReturnType<typeof vi.fn>;
    resolveReaderTranscriptSource = (await import("@/lib/correction/resolve"))
      .resolveReaderTranscriptSource as ReturnType<typeof vi.fn>;
    const readerModule = await import("@/lib/correction/reader-transcript");
    getReaderCorrectionState = readerModule.getReaderCorrectionState as ReturnType<
      typeof vi.fn
    >;
    loadPublishedTranscript = readerModule.loadPublishedTranscript as ReturnType<
      typeof vi.fn
    >;

    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
    listTranscriptBackendPriorities.mockResolvedValue({});
    getAvailableTranscripts.mockResolvedValue({
      hash: VALID_HASH,
      backends: [MACHINE_BACKEND],
    });
    getReaderCorrectionState.mockResolvedValue(PROGRESS);
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canSeeTranscriptVariants: false,
      canSeeSpeakers: true,
    });
  });

  describe("an eligible primary transcript that has never been published", () => {
    beforeEach(() => {
      resolveReaderTranscriptSource.mockResolvedValue({
        kind: "withheld",
        workspaceId: "ws-1",
      });
    });

    it("lists no transcript and returns correction progress instead", async () => {
      const response = await call();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        hash: VALID_HASH,
        backends: [],
        correction: PROGRESS,
      });
    });

    it("refuses the machine transcript underneath it", async () => {
      const response = await call(MACHINE_BACKEND);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "TRANSCRIPT_NOT_PUBLISHED",
      });
      expect(loadTranscript).not.toHaveBeenCalled();
    });

    it("refuses the corrected key as well, since nothing is published", async () => {
      const response = await call(CORRECTED);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "TRANSCRIPT_NOT_PUBLISHED",
        correction: PROGRESS,
      });
    });

    it("still shows machine variants to the administrative view", async () => {
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canSeeTranscriptVariants: true,
        canSeeSpeakers: true,
      });
      loadTranscript.mockResolvedValue({
        backend: MACHINE_BACKEND,
        hash: VALID_HASH,
        segments: [{ start: 0, end: 1, text: "machine" }],
      });

      const listing = await call();
      await expect(listing.json()).resolves.toMatchObject({
        backends: [MACHINE_BACKEND],
      });

      const transcript = await call(MACHINE_BACKEND);
      expect(transcript.status).toBe(200);
    });
  });

  describe("a published corrected transcript", () => {
    beforeEach(() => {
      resolveReaderTranscriptSource.mockResolvedValue({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
      loadPublishedTranscript.mockResolvedValue({
        backend: CORRECTED,
        hash: VALID_HASH,
        segments: [{ start: 0, end: 1, text: "human words", words: [] }],
      });
    });

    it("offers the corrected transcript first", async () => {
      const response = await call();

      await expect(response.json()).resolves.toMatchObject({
        backends: [CORRECTED],
      });
    });

    it("serves the published text", async () => {
      const response = await call(CORRECTED);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        segments: [{ text: "human words" }],
      });
    });

    it("keeps the machine text out of the ordinary reader", async () => {
      const response = await call(MACHINE_BACKEND);

      expect(response.status).toBe(403);
      expect(loadTranscript).not.toHaveBeenCalled();
    });
  });

  describe("a recording outside correction scope", () => {
    beforeEach(() => {
      resolveReaderTranscriptSource.mockResolvedValue({ kind: "machine" });
      loadTranscript.mockResolvedValue({
        backend: MACHINE_BACKEND,
        hash: VALID_HASH,
        segments: [{ start: 0, end: 1, text: "machine" }],
      });
    });

    it("keeps its configured machine transcript", async () => {
      const listing = await call();
      await expect(listing.json()).resolves.toEqual({
        hash: VALID_HASH,
        backends: [MACHINE_BACKEND],
      });

      const transcript = await call(MACHINE_BACKEND);
      expect(transcript.status).toBe(200);
      await expect(transcript.json()).resolves.toMatchObject({
        segments: [{ text: "machine" }],
      });
    });
  });
});
