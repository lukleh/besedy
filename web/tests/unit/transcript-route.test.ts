import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getTranscript } from "@/app/api/transcript/[hash]/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
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

const VALID_HASH = "a".repeat(64);

describe("transcript route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
  let getAvailableTranscripts: ReturnType<typeof vi.fn>;
  let loadTranscript: ReturnType<typeof vi.fn>;
  let listTranscriptBackendPriorities: ReturnType<typeof vi.fn>;
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
    getAvailableTranscripts = transcriptModule.getAvailableTranscripts as ReturnType<typeof vi.fn>;
    loadTranscript = transcriptModule.loadTranscript as ReturnType<typeof vi.fn>;
    const priorityModule = await import("@/lib/transcript-priority");
    listTranscriptBackendPriorities = priorityModule.listTranscriptBackendPriorities as ReturnType<typeof vi.fn>;
    const pathsModule = await import("@/lib/paths");
    resolveTranscriptsPath = pathsModule.resolveTranscriptsPath as ReturnType<typeof vi.fn>;

    listTranscriptBackendPriorities.mockResolvedValue({});
  });

  describe("access control", () => {
    it("denies transcript access for LISTENER users", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: false,
      });

      const request = new NextRequest(`http://localhost/api/transcript/${VALID_HASH}`);
      const response = await getTranscript(request, { params: Promise.resolve({ hash: VALID_HASH }) });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe(
        "Current catalog permissions do not allow transcript access"
      );
    });

    // Machine transcripts other than the default are administrative: they are
    // unevaluated model output, and an ordinary reader reads the one default.
    it("lists only the default transcript without the administrative view", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canSeeTranscriptVariants: false,
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      getAvailableTranscripts.mockResolvedValue({
        hash: VALID_HASH,
        backends: ["faster-whisper/large-v3@silero_vad_v6", "whisperx/large-v3@pyannote_v3"],
      });

      const response = await getTranscript(
        new NextRequest(`http://localhost/api/transcript/${VALID_HASH}`),
        { params: Promise.resolve({ hash: VALID_HASH }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        backends: ["faster-whisper/large-v3@silero_vad_v6"],
      });
    });

    it("lists every transcript for the administrative view", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canSeeTranscriptVariants: true,
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      getAvailableTranscripts.mockResolvedValue({
        hash: VALID_HASH,
        backends: ["faster-whisper/large-v3@silero_vad_v6", "whisperx/large-v3@pyannote_v3"],
      });

      const response = await getTranscript(
        new NextRequest(`http://localhost/api/transcript/${VALID_HASH}`),
        { params: Promise.resolve({ hash: VALID_HASH }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        backends: ["faster-whisper/large-v3@silero_vad_v6", "whisperx/large-v3@pyannote_v3"],
      });
    });

    it("refuses a transcript other than the default without the administrative view", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canSeeTranscriptVariants: false,
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      getAvailableTranscripts.mockResolvedValue({
        hash: VALID_HASH,
        backends: ["faster-whisper/large-v3@silero_vad_v6", "whisperx/large-v3@pyannote_v3"],
      });

      const response = await getTranscript(
        new NextRequest(
          `http://localhost/api/transcript/${VALID_HASH}?backend=whisperx/large-v3@pyannote_v3`
        ),
        { params: Promise.resolve({ hash: VALID_HASH }) }
      );

      expect(response.status).toBe(403);
      expect(loadTranscript).not.toHaveBeenCalled();
    });

    it("strips the speaker on each segment without the speaker view", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
        canSeeTranscriptVariants: true,
        canSeeSpeakers: false,
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      getAvailableTranscripts.mockResolvedValue({
        hash: VALID_HASH,
        backends: ["faster-whisper/large-v3@silero_vad_v6"],
      });
      loadTranscript.mockResolvedValue({
        segments: [{ start: 0, end: 1, text: "Hello", speaker: "SPEAKER_00" }],
        language: "cs",
      });

      const response = await getTranscript(
        new NextRequest(
          `http://localhost/api/transcript/${VALID_HASH}?backend=faster-whisper/large-v3@silero_vad_v6`
        ),
        { params: Promise.resolve({ hash: VALID_HASH }) }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.segments[0]).toEqual({ start: 0, end: 1, text: "Hello" });
    });

    it("denies access when user cannot access the audio hash", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: false,
        canViewRecordingTranscripts: false,
      });

      const request = new NextRequest(`http://localhost/api/transcript/${VALID_HASH}`);
      const response = await getTranscript(request, { params: Promise.resolve({ hash: VALID_HASH }) });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/Access denied/);
    });

    it("allows VIEWER to access transcript", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
      });
      resolveTranscriptsPath.mockResolvedValue("/transcripts");
      getAvailableTranscripts.mockResolvedValue({
        hash: VALID_HASH,
        backends: ["faster-whisper/large-v3@silero_vad_v6"],
      });
      loadTranscript.mockResolvedValue({
        segments: [{ start: 0, end: 1, text: "Hello" }],
        language: "en",
      });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}?backend=faster-whisper/large-v3@silero_vad_v6`
      );
      const response = await getTranscript(request, { params: Promise.resolve({ hash: VALID_HASH }) });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("segments");
      expect(body).toHaveProperty("language");
    });
  });

  describe("input validation", () => {
    it("rejects invalid hash format", async () => {
      requireAuth.mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/transcript/invalid-hash");
      const response = await getTranscript(request, { params: Promise.resolve({ hash: "invalid-hash" }) });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid hash/);
    });

    it("rejects invalid backend parameter", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: true,
      });

      const request = new NextRequest(
        `http://localhost/api/transcript/${VALID_HASH}?backend=invalid-backend`
      );
      const response = await getTranscript(request, { params: Promise.resolve({ hash: VALID_HASH }) });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid backend/);
    });
  });

  describe("group resolution", () => {
    it("returns 404 when no workflow group is configured", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue(null);

      const request = new NextRequest(`http://localhost/api/transcript/${VALID_HASH}`);
      const response = await getTranscript(request, { params: Promise.resolve({ hash: VALID_HASH }) });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toMatch(/No workflow group/);
    });
  });
});
