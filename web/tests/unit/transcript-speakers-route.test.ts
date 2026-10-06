import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getSpeakers } from "@/app/api/catalogs/[id]/recordings/[hash]/transcript/speakers/route";

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
  let findActiveCatalog: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const groupModule = await import("@/lib/catalog/resolve-group");
    findActiveCatalog = groupModule.findActiveCatalog as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
  });

  describe("input validation", () => {
    it("rejects invalid hash format", async () => {
      findActiveCatalog.mockResolvedValue({ id: "20251225_120000" });
      const request = new NextRequest(
        "http://localhost/api/catalogs/20251225_120000/recordings/invalid-hash/transcript/speakers"
      );
      const response = await getSpeakers(request, {
        params: Promise.resolve({ id: "20251225_120000", hash: "invalid-hash" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/Invalid hash/);
    });
  });

  describe("access control", () => {
    it("denies speaker data for listener-level transcript access", async () => {
      requireAuth.mockResolvedValue("user-1");
      findActiveCatalog.mockResolvedValue({ id: "20251225_120000" });
      getRecordingCapability.mockResolvedValue({
        canAccessRecording: true,
        canViewRecordingTranscripts: false,
      });

      const request = new NextRequest(
        "http://localhost/api/catalogs/20251225_120000/recordings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/transcript/speakers"
      );
      const response = await getSpeakers(request, {
        params: Promise.resolve({
          id: "20251225_120000",
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
