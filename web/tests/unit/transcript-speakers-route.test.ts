import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getSpeakers } from "@/app/api/transcript/[hash]/speakers/route";

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
  getAvailableDiarizations: vi.fn(),
  loadDiarization: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

describe("transcript speakers route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const groupModule = await import("@/lib/catalog/resolve-group");
    resolveActiveGroup = groupModule.resolveActiveGroup as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
  });

  describe("input validation", () => {
    it("rejects invalid hash format", async () => {
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      const request = new NextRequest(
        "http://localhost/api/transcript/invalid-hash/speakers"
      );
      const response = await getSpeakers(request, {
        params: Promise.resolve({ hash: "invalid-hash" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid hash/);
    });
  });

  describe("access control", () => {
    it("denies speaker data for listener-level transcript access", async () => {
      requireAuth.mockResolvedValue("user-1");
      resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: false,
      });

      const request = new NextRequest(
        "http://localhost/api/transcript/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/speakers"
      );
      const response = await getSpeakers(request, {
        params: Promise.resolve({
          hash: "a".repeat(64),
        }),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe(
        "Current catalog permissions do not allow transcript access"
      );
    });
  });
});
