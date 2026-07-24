import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogEntryRoute } from "@/app/api/catalogs/[id]/recordings/[hash]/entry/route";

const HASH = "a".repeat(64);
const CATALOG_ID = "20260101_120000";

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

vi.mock("@/lib/catalog", () => ({
  getCatalogEntry: vi.fn(),
  countDuplicatesByHash: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findFirst: vi.fn(),
    },
    audioMetadata: {
      findUnique: vi.fn(),
    },
  },
}));

describe("catalog entry route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let getCatalogEntry: ReturnType<typeof vi.fn>;
  let countDuplicatesByHash: ReturnType<typeof vi.fn>;
  let logAccessDenied: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    audioMetadata: { findUnique: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const capabilityModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      capabilityModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    const auditModule = await import("@/lib/audit/logger");
    logAccessDenied = auditModule.logAccessDenied as ReturnType<typeof vi.fn>;
    const catalogModule = await import("@/lib/catalog");
    getCatalogEntry = catalogModule.getCatalogEntry as ReturnType<typeof vi.fn>;
    countDuplicatesByHash =
      catalogModule.countDuplicatesByHash as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("denies users without catalog access before loading the entry", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: false,
      canAccessRecording: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/entry`
    );
    const response = await getCatalogEntryRoute(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied to this catalog/);
    expect(getCatalogEntry).not.toHaveBeenCalled();
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "catalog_entry",
      CATALOG_ID,
      {
        groupId: CATALOG_ID,
        reason: "No access grant",
      }
    );
  });

  it("returns 404 for listeners when the recording is hidden", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: false,
    });
    getCatalogEntry.mockResolvedValue({
      hash: HASH,
      filename: "recording.wav",
      duration: "00:01:23",
      hasArchived: true,
      hasMetadata: true,
      isActionable: false,
      isPublished: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/entry`
    );
    const response = await getCatalogEntryRoute(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/Recording not found in catalog/);
  });

  it("omits path-bearing fields from the public entry DTO", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "MEMBER",
      canAccessRecording: true,
      canViewRecordingTranscripts: true,
      canEditRecording: false,
      canDownloadRecording: true,
    });
    getCatalogEntry.mockResolvedValue({
      hash: HASH,
      compressedPath: "/archive/recording.webm",
      filename: "recording.wav",
      originalPath: "/source/recording.wav",
      scanRoot: "/source",
      duration: "00:01:23",
      title: "Source Title",
      artist: "Source Artist",
      date: "2024-01-02",
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
    });
    prisma.audioMetadata.findUnique.mockResolvedValue({
      title: "Curated Title",
      artist: "Curated Artist",
      dateYear: 2024,
      dateMonth: 1,
      dateDay: 2,
      verified: true,
      verifiedAt: new Date("2024-01-03T10:00:00.000Z"),
      tags: ["favorite"],
      notes: "important",
      recorderId: 12,
      recorder: { id: 12, name: "Recorder" },
      locationId: 7,
      location: { id: 7, name: "Prague" },
      albumId: 3,
      album: { id: 3, name: "Album" },
      part: 1,
    });
    countDuplicatesByHash.mockResolvedValue(new Map([[HASH, 2]]));

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/entry`
    );
    const response = await getCatalogEntryRoute(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entry).toMatchObject({
      hash: HASH,
      title: "Source Title",
      curatedTitle: "Curated Title",
      curatedArtist: "Curated Artist",
      album: { id: 3, name: "Album" },
      hasArchivedAudio: true,
      hasOriginalAudio: true,
      duplicateCount: 2,
    });
    expect(body.entry.originalPath).toBeUndefined();
    expect(body.entry.compressedPath).toBeUndefined();
    expect(body.entry.scanRoot).toBeUndefined();
  });
});
