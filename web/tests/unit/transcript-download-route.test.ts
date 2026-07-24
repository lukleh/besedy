import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as downloadTranscript } from "@/app/api/transcript/[hash]/download/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveActiveGroup: vi.fn(),
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
}));

const VALID_HASH = "a".repeat(64);

describe("transcript download route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
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
    resolveActiveGroup = groupModule.resolveActiveGroup as ReturnType<typeof vi.fn>;
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
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      readTranscriptFile.mockResolvedValue(
        { content: JSON.stringify({ segments: [{ start: 0, end: 1, text: "Hello" }] }), filename: "transcript.json" }
      );

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=invalid-backend&format=json`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid backend/);
    });

    it("rejects invalid format parameter", async () => {
      requireAuth.mockResolvedValue("user-1");

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/download?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6&format=invalid-format`
      );
      const response = await downloadTranscript(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid format/);
    });
  });
});
