import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveActiveGroup: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

describe("transcript route access", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let logAccessDenied: ReturnType<typeof vi.fn>;
  let resolveTranscriptsPath: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    resolveActiveGroup = (
      await import("@/lib/catalog/resolve-group")
    ).resolveActiveGroup as ReturnType<typeof vi.fn>;
    getRecordingCapability = (
      await import("@/lib/access/capabilities")
    ).getRecordingCapability as ReturnType<typeof vi.fn>;
    logAccessDenied = (await import("@/lib/audit/logger"))
      .logAccessDenied as ReturnType<typeof vi.fn>;
    resolveTranscriptsPath = (
      await import("@/lib/paths")
    ).resolveTranscriptsPath as ReturnType<typeof vi.fn>;
  });

  it("returns 404 when no workflow group is configured", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue(null);

    const result = await resolveTranscriptRouteAccess({
      groupOverride: null,
      hash: "a".repeat(64),
      accessDeniedMessage: "Access denied to this transcript",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(404);
    await expect(result.response.json()).resolves.toEqual({
      error: "No workflow group configured",
    });
  });

  it("returns 403 and logs when recording access is denied", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "catalog-1" });
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
    });

    const result = await resolveTranscriptRouteAccess({
      groupOverride: null,
      hash: "a".repeat(64),
      accessDeniedMessage: "Access denied to this transcript",
      auditResource: "transcript",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Access denied to this transcript",
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "transcript",
      "a".repeat(64),
      { groupId: "catalog-1" }
    );
  });

  it("returns 403 when transcript viewing is denied", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "catalog-1" });
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
    });

    const result = await resolveTranscriptRouteAccess({
      groupOverride: null,
      hash: "a".repeat(64),
      accessDeniedMessage: "Access denied to this transcript",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Current catalog permissions do not allow transcript access",
    });
  });

  it("returns 403 when download is required but not allowed", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "catalog-1" });
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canDownloadRecording: false,
    });

    const result = await resolveTranscriptRouteAccess({
      groupOverride: null,
      hash: "a".repeat(64),
      accessDeniedMessage: "Access denied to this transcript",
      requireDownload: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Download not permitted for this transcript",
    });
  });

  it("returns the shared transcript route context on success", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "catalog-1" });
    getRecordingCapability.mockResolvedValue({
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canDownloadRecording: true,
    });
    resolveTranscriptsPath.mockReturnValue("/transcripts/catalog-1");

    const result = await resolveTranscriptRouteAccess({
      groupOverride: "catalog-1",
      hash: "a".repeat(64),
      accessDeniedMessage: "Access denied to this transcript",
      requireDownload: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.userId).toBe("user-1");
    expect(result.group).toEqual({ id: "catalog-1" });
    expect(result.transcriptsPath).toBe("/transcripts/catalog-1");
    expect(result.capability.canDownloadRecording).toBe(true);
  });
});
