import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAudioSources } from "@/app/api/catalogs/[id]/recordings/[hash]/audio/sources/route";

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

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowVariant: {
      findMany: vi.fn(),
    },
    catalogListeningEntry: {
      findUnique: vi.fn(),
    },
    catalogEntry: {
      findUnique: vi.fn(),
    },
  },
}));

describe("catalog audio sources route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowVariant: { findMany: ReturnType<typeof vi.fn> };
    catalogListeningEntry: { findUnique: ReturnType<typeof vi.fn> };
    catalogEntry: { findUnique: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("rejects invalid hash format", async () => {
    const request = new NextRequest(
      "http://localhost/api/catalogs/20250101_120000/recordings/invalid-hash/audio/sources"
    );
    const response = await getAudioSources(request, {
      params: Promise.resolve({ id: "20250101_120000", hash: "invalid-hash" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid route parameters/);
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("denies access before loading variants", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      canAccessRecording: false,
    });

    const request = new NextRequest(
      "http://localhost/api/catalogs/20250101_120000/recordings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio/sources"
    );
    const response = await getAudioSources(request, {
      params: Promise.resolve({
        id: "20250101_120000",
        hash: "a".repeat(64),
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
    expect(prisma.workflowVariant.findMany).not.toHaveBeenCalled();
  });

  it("lists the formats each source can be served in", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      canAccessRecording: true,
    });
    prisma.catalogEntry.findUnique.mockResolvedValue({
      compressedPath: "/data/audio/talk_aaaaaaaa.webm",
      compressedAacPath: "/data/audio/talk_aaaaaaaa.m4a",
    });
    prisma.workflowVariant.findMany.mockResolvedValue([
      { variant: "enhanced", label: "Enhanced", listeningArchivedCatalogPath: "/c/e.csv" },
      { variant: "quiet", label: "Quiet", listeningArchivedCatalogPath: "/c/q.csv" },
      { variant: "missing", label: "Missing", listeningArchivedCatalogPath: "/c/m.csv" },
    ]);
    prisma.catalogListeningEntry.findUnique.mockImplementation(
      async ({ where }: { where: { workflowGroupId_variant_audioHash: { variant: string } } }) => {
        const variant = where.workflowGroupId_variant_audioHash.variant;
        if (variant === "enhanced") return { compressedPath: "/x.webm", compressedAacPath: "/x.m4a" };
        if (variant === "quiet") return { compressedPath: "/q.webm", compressedAacPath: null };
        return null;
      },
    );

    const response = await getAudioSources(
      new NextRequest(
        `http://localhost/api/catalogs/20250101_120000/recordings/${"a".repeat(64)}/audio/sources`,
      ),
      { params: Promise.resolve({ id: "20250101_120000", hash: "a".repeat(64) }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.sources.map((source: { id: string; available: boolean; formats: string[] }) => [
        source.id,
        source.available,
        source.formats,
      ]),
    ).toEqual([
      ["archived", true, ["webm", "aac"]],
      ["listening:enhanced", true, ["webm", "aac"]],
      ["listening:quiet", true, ["webm"]],
      ["listening:missing", false, []],
    ]);
    // No server path leaves the route.
    expect(JSON.stringify(body)).not.toContain(".m4a");
  });

  it("lists only the WebM when the archive has no AAC copy yet", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({ catalogExists: true, canAccessRecording: true });
    prisma.catalogEntry.findUnique.mockResolvedValue({
      compressedPath: "/data/audio/talk_aaaaaaaa.webm",
      compressedAacPath: null,
    });
    prisma.workflowVariant.findMany.mockResolvedValue([]);

    const response = await getAudioSources(
      new NextRequest(
        `http://localhost/api/catalogs/20250101_120000/recordings/${"a".repeat(64)}/audio/sources`,
      ),
      { params: Promise.resolve({ id: "20250101_120000", hash: "a".repeat(64) }) },
    );

    const body = await response.json();
    expect(body.sources).toEqual([
      { id: "archived", label: "Archived", type: "archived", available: true, formats: ["webm"] },
    ]);
  });

  it("marks an archive without a catalogued WebM unavailable", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({ catalogExists: true, canAccessRecording: true });
    prisma.catalogEntry.findUnique.mockResolvedValue({ compressedPath: null, compressedAacPath: null });
    prisma.workflowVariant.findMany.mockResolvedValue([]);

    const response = await getAudioSources(
      new NextRequest(
        `http://localhost/api/catalogs/20250101_120000/recordings/${"a".repeat(64)}/audio/sources`,
      ),
      { params: Promise.resolve({ id: "20250101_120000", hash: "a".repeat(64) }) },
    );

    const body = await response.json();
    expect(body.sources[0]).toMatchObject({ id: "archived", available: false, formats: [] });
  });
});
