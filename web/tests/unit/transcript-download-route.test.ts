import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as downloadTranscript } from "@/app/api/catalogs/[id]/recordings/[hash]/transcript/download/route";

// Correction resolution is exercised in its own tests; these route tests cover
// recordings outside correction scope, where the machine transcript is served.
vi.mock("@/lib/correction/resolve", () => ({
  resolveReaderTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveSearchTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveOriginalTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveReaderTranscriptSources: vi.fn(async (_catalogId, hashes) => {
    const map = new Map();
    for (const hash of hashes) map.set(hash, { kind: "machine" });
    return map;
  }),
  publicationArtifactPath: vi.fn(() => "/tmp/publication/transcript.json"),
  frozenSourcePath: vi.fn(() => "/tmp/workspace/source/transcript.json"),
}));

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  findActiveCatalog: vi.fn(),
}));

vi.mock("@/lib/transcript", () => ({
  readTranscriptFile: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
  logTranscriptDownloaded: vi.fn(),
  logOriginalTranscriptDownloaded: vi.fn(),
}));

vi.mock("@/lib/correction/reader-transcript", () => ({
  readPublishedTranscriptFile: vi.fn(),
}));

vi.mock("@/lib/correction/storage", () => ({
  readTextFile: vi.fn(),
}));

vi.mock("@/lib/correction/source", () => ({
  resolveConfiguredDefaultBackend: vi.fn(),
}));

const VALID_HASH = "a".repeat(64);

describe("transcript download route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let findActiveCatalog: ReturnType<typeof vi.fn>;
  let readTranscriptFile: ReturnType<typeof vi.fn>;
  let resolveTranscriptsPath: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    const groupModule = await import("@/lib/catalog/resolve-group");
    findActiveCatalog = groupModule.findActiveCatalog as ReturnType<typeof vi.fn>;
    const transcriptModule = await import("@/lib/transcript");
    readTranscriptFile = transcriptModule.readTranscriptFile as ReturnType<typeof vi.fn>;
    const pathsModule = await import("@/lib/paths");
    resolveTranscriptsPath = pathsModule.resolveTranscriptsPath as ReturnType<typeof vi.fn>;
  });

  describe("access control", () => {
    it("returns 401 when not authenticated", async () => {
      requireAuth.mockRejectedValue({
        message: "Authentication required",
        statusCode: 401,
      });

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toMatch(/Authentication required/);
    });

    it("denies downloads when canDownload is false", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canDownloadRecording: false,
        canDownloadTranscripts: false,
      });
      findActiveCatalog.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/Download not permitted/);
    });

    it("denies access when user cannot access the audio hash", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: false,
        canViewRecordingTranscripts: false,
        canDownloadRecording: false,
        canDownloadTranscripts: false,
      });
      findActiveCatalog.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/Access denied/);
    });

    it("allows download when canDownload is true", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canDownloadRecording: true,
        canDownloadTranscripts: true,
      });
      findActiveCatalog.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      readTranscriptFile.mockResolvedValue(
        { content: JSON.stringify({ segments: [{ start: 0, end: 1, text: "Hello" }] }), filename: "transcript.json" }
      );

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      // Should return 200 with file content
      expect(response.status).toBe(200);
      // Response should have content-disposition header for download
      expect(response.headers.get("content-type")).toMatch(/json/);
    });
  });

  describe("input validation", () => {
    it("rejects invalid backend parameter", async () => {
      requireAuth.mockResolvedValue("user-1");

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=invalid-backend&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid backend/);
    });

    it("rejects invalid format parameter", async () => {
      requireAuth.mockResolvedValue("user-1");

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?backend=faster-whisper/large-v3@silero_vad_v6&format=invalid-format`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid format/);
    });
  });
});

describe("transcript download route under the reading gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const GROUP = "20251225_120000";
  const MACHINE = "faster-whisper/large-v3@silero_vad_v6";

  async function arrange(capability: Record<string, boolean>) {
    const { requireAuth } = await import("@/lib/auth/permissions");
    const { getRecordingCapability } = await import("@/lib/access/capabilities");
    const { findActiveCatalog } = await import("@/lib/catalog/resolve-group");
    const { resolveTranscriptsPath } = await import("@/lib/paths");
    const { readTranscriptFile } = await import("@/lib/transcript");
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(getRecordingCapability).mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canDownloadRecording: true,
      canDownloadTranscripts: true,
      ...capability,
    } as never);
    vi.mocked(findActiveCatalog).mockResolvedValue({ id: GROUP, isActive: true } as never);
    vi.mocked(resolveTranscriptsPath).mockResolvedValue("/transcripts" as never);
    vi.mocked(readTranscriptFile).mockResolvedValue({
      content: JSON.stringify({ segments: [] }),
      filename: "transcript.json",
    });
  }

  function run(query: string) {
    return downloadTranscript(
      new NextRequest(`http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/download?${query}`),
      { params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }) }
    );
  }

  // Seeing machine variants is a reading right; taking the machine text out
  // of a recording in correction scope is download_original_transcript.
  it("refuses the machine text of a recording in correction scope even to the administrative view", async () => {
    await arrange({ canSeeTranscriptVariants: true });
    const { resolveReaderTranscriptSource } = await import("@/lib/correction/resolve");
    vi.mocked(resolveReaderTranscriptSource).mockResolvedValueOnce({
      kind: "publication",
      workspaceId: "ws-1",
      publicationId: "pub-1",
    });

    const response = await run(`backend=${encodeURIComponent(MACHINE)}&format=json`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TRANSCRIPT_NOT_PUBLISHED" });
  });

  it("serves the published artifact for the corrected key", async () => {
    await arrange({});
    const { resolveReaderTranscriptSource } = await import("@/lib/correction/resolve");
    const { readPublishedTranscriptFile } = await import("@/lib/correction/reader-transcript");
    vi.mocked(resolveReaderTranscriptSource).mockResolvedValueOnce({
      kind: "publication",
      workspaceId: "ws-1",
      publicationId: "pub-1",
    });
    vi.mocked(readPublishedTranscriptFile).mockResolvedValue({
      content: "1\n00:00:00,000 --> 00:00:01,000\nCorrected\n",
      filename: "transcript.srt",
    });

    const response = await run("backend=corrected%2Fpublished&format=srt");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Corrected");
  });

  it("refuses the original without download_original_transcript", async () => {
    await arrange({ canDownloadOriginalTranscript: false });

    const response = await run(`backend=${encodeURIComponent(MACHINE)}&format=json&original=1`);

    expect(response.status).toBe(403);
  });

  // Once correction has started the original is the frozen source the
  // corrections were made against, kept as JSON only, and its download is a
  // distinct audit event.
  it("serves the frozen source as the original once correction has started, and logs it as such", async () => {
    await arrange({ canDownloadOriginalTranscript: true });
    const { resolveOriginalTranscriptSource } = await import("@/lib/correction/resolve");
    const { readTextFile } = await import("@/lib/correction/storage");
    const { logOriginalTranscriptDownloaded, logTranscriptDownloaded } = await import("@/lib/audit/logger");
    vi.mocked(resolveOriginalTranscriptSource).mockResolvedValue({
      kind: "frozen",
      workspaceId: "ws-1",
      backend: MACHINE,
    });
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ segments: [{ text: "frozen" }] }));

    const sidecar = await run(`backend=${encodeURIComponent(MACHINE)}&format=txt&original=1`);
    expect(sidecar.status).toBe(404);

    // Asked for under the corrected key, but what leaves is the frozen machine
    // source, and the filename and the audit event say so.
    const response = await run("backend=corrected%2Fpublished&format=json&original=1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("frozen");
    expect(response.headers.get("content-disposition")).toContain(
      "faster-whisper_large-v3@silero_vad_v6_original.json"
    );
    expect(logOriginalTranscriptDownloaded).toHaveBeenCalledWith(
      "user-1",
      VALID_HASH,
      GROUP,
      expect.objectContaining({ source: "frozen", backend: MACHINE })
    );
    expect(logTranscriptDownloaded).not.toHaveBeenCalled();
  });
});
