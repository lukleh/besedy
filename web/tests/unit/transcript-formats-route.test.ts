import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getFormats } from "@/app/api/transcript/[hash]/formats/route";

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
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
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
    resolveActiveGroup = groupModule.resolveActiveGroup as ReturnType<typeof vi.fn>;
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
        `http://localhost/api/transcript/${VALID_HASH}/formats?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000", isActive: true });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/formats?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/VIEWER role or higher/);
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
        `http://localhost/api/transcript/${VALID_HASH}/formats?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockReturnValue("/transcripts");
      getAvailableFormats.mockResolvedValue({
        formats: ["json", "srt"],
      });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/formats?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
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
      });
      resolveActiveGroup.mockResolvedValue({
        id: "20251225_120000",
        isActive: true,
        transcriptsPath: "/transcripts",
      });
      resolveTranscriptsPath.mockReturnValue("/transcripts");
      // Return null to indicate no transcript found
      getAvailableFormats.mockResolvedValue(null);

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}/formats?group=20251225_120000&backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: VALID_HASH }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe("input validation", () => {
    it("rejects invalid hash format", async () => {
      const request = new NextRequest(
        "http://localhost/api/transcript/invalid-hash/formats"
      );
      const response = await getFormats(request, {
        params: Promise.resolve({ hash: "invalid-hash" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid hash/);
    });
  });
});
