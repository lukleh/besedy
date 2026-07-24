import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCompare } from "@/app/api/transcript/[hash]/compare/route";

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

describe("transcript compare route", () => {
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

  it("computes duration from max end time even for overlapping intervals", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
    });
    resolveTranscriptsPath.mockReturnValue("/transcripts");
    getAvailableTranscripts.mockResolvedValue({
      hash: VALID_HASH,
      backends: ["backend/a", "backend/b"],
    });

    loadTranscript.mockImplementation(
      async (_transcriptsPath: string, _hash: string, backend: string) => {
        if (backend === "backend/a") {
          return {
            backend,
            hash: VALID_HASH,
            segments: [
              { start: 0, end: 10, text: "long segment" },
              { start: 5, end: 6, text: "overlap" },
            ],
          };
        }
        if (backend === "backend/b") {
          return {
            backend,
            hash: VALID_HASH,
            segments: [{ start: 1, end: 7, text: "second backend" }],
          };
        }
        return null;
      }
    );

    const request = new NextRequest(`http://localhost/api/transcript/${VALID_HASH}/compare`);
    const response = await getCompare(request, { params: Promise.resolve({ hash: VALID_HASH }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.duration).toBe(10);
  });
});
