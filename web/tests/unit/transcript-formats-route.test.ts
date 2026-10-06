import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getFormats } from "@/app/api/catalogs/[id]/recordings/[hash]/transcript/formats/route";

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

vi.mock("@/lib/correction/reader-transcript", () => ({
  PUBLISHED_TRANSCRIPT_FORMATS: ["json", "txt", "srt", "vtt"],
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
  getAvailableFormats: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

const VALID_HASH = "a".repeat(64);

describe("transcript formats route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let findActiveCatalog: ReturnType<typeof vi.fn>;
  let getAvailableFormats: ReturnType<typeof vi.fn>;
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
    getAvailableFormats = transcriptModule.getAvailableFormats as ReturnType<typeof vi.fn>;
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
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toMatch(/Authentication required/);
    });

    it("denies transcript formats for LISTENER access", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: false,
        canDownloadRecording: false,
        canDownloadTranscripts: false,
      });
      findActiveCatalog.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe(
        "Current catalog permissions do not allow transcript access"
      );
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
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/Access denied/);
    });

    it("allows VIEWER to get available formats", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canDownloadRecording: false,
        canDownloadTranscripts: false,
      });
      findActiveCatalog.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockReturnValue("/transcripts");
      getAvailableFormats.mockResolvedValue({
        formats: ["json", "srt"],
      });

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      // Verify response structure matches route implementation
      expect(body).toHaveProperty("hash");
      expect(body).toHaveProperty("backend");
      expect(body).toHaveProperty("formats");
      expect(body).toHaveProperty("canDownload");
      expect(Array.isArray(body.formats)).toBe(true);
    });
  });

  describe("response structure", () => {
    it("returns 404 when no transcripts available for backend", async () => {
      requireAuth.mockResolvedValue("user-1");
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canDownloadRecording: false,
        canDownloadTranscripts: false,
      });
      findActiveCatalog.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockReturnValue("/transcripts");
      // Return null to indicate no transcript found
      getAvailableFormats.mockResolvedValue(null);

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe("input validation", () => {
    it("rejects invalid hash format", async () => {
      const request = new NextRequest(
        "http://localhost/api/catalogs/20251225_120000/recordings/invalid-hash/transcript/formats"
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: "invalid-hash" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid hash/);
    });
  });
});

describe("transcript formats route under the reading gate", () => {
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
    const { getAvailableFormats } = await import("@/lib/transcript");
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(getRecordingCapability).mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canDownloadRecording: true,
      canDownloadTranscripts: true,
      ...capability,
    } as never);
    vi.mocked(findActiveCatalog).mockResolvedValue({ id: GROUP, isActive: true } as never);
    vi.mocked(resolveTranscriptsPath).mockReturnValue("/transcripts" as never);
    vi.mocked(getAvailableFormats).mockResolvedValue({ formats: ["json", "srt"] } as never);
  }

  function run(backend: string) {
    return getFormats(
      new NextRequest(`http://localhost/api/catalogs/20251225_120000/recordings/${VALID_HASH}/transcript/formats?backend=${encodeURIComponent(backend)}`),
      { params: Promise.resolve({ id: "20251225_120000", hash: VALID_HASH }) }
    );
  }

  it("lists a machine variant of a recording in correction scope as inspectable but not downloadable", async () => {
    await arrange({ canSeeTranscriptVariants: true });
    const { resolveReaderTranscriptSource } = await import("@/lib/correction/resolve");
    vi.mocked(resolveReaderTranscriptSource).mockResolvedValueOnce({ kind: "withheld", workspaceId: "ws-1" });

    const response = await run(MACHINE);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ formats: ["json", "srt"], canDownload: false });
  });

  it("lists all four formats for a published correction without probing disk", async () => {
    await arrange({});
    const { resolveReaderTranscriptSource } = await import("@/lib/correction/resolve");
    const { getAvailableFormats } = await import("@/lib/transcript");
    vi.mocked(resolveReaderTranscriptSource).mockResolvedValueOnce({
      kind: "publication",
      workspaceId: "ws-1",
      publicationId: "pub-1",
    });

    const response = await run("corrected/published");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      formats: ["json", "txt", "srt", "vtt"],
      canDownload: true,
    });
    expect(getAvailableFormats).not.toHaveBeenCalled();
  });
});
