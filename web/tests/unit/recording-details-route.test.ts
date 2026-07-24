import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRecordingDetails } from "@/app/api/catalogs/[id]/recordings/[hash]/details/route";

const HASH = "b".repeat(64);
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
  getFullCatalogEntry: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
  },
}));

describe("recording details route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let getFullCatalogEntry: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    const catalogModule = await import("@/lib/catalog");
    getFullCatalogEntry =
      catalogModule.getFullCatalogEntry as ReturnType<typeof vi.fn>;
  });

  it("denies non-editors before loading source details", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditRecording: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/details`
    );
    const response = await getRecordingDetails(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/edit permission/i);
    expect(getFullCatalogEntry).not.toHaveBeenCalled();
  });

  it("returns editor details with a sanitized entry shell", async () => {
    requireAuth.mockResolvedValue("editor-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditRecording: true,
    });
    getFullCatalogEntry.mockResolvedValue({
      entry: {
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
      },
      fullMetadata: {
        Hash: HASH,
        Filename: "recording.wav",
        "Full Path": "/source/recording.wav",
        "Scan Root": "/source",
        Duration: "00:01:23",
        title: "Source Title",
      },
      fullArchived: {
        Hash: HASH,
        "Original Path": "/source/recording.wav",
        "Compressed Path": "/archive/recording.webm",
        Duration: "00:01:23",
      },
      duplicates: [
        {
          Hash: HASH,
          "Original Path": "/source/recording.wav",
          "Duplicate Path": "/duplicates/recording-copy.wav",
        },
      ],
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/details`
    );
    const response = await getRecordingDetails(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entry).toMatchObject({
      hash: HASH,
      hasArchivedAudio: true,
      hasOriginalAudio: true,
    });
    expect(body.entry.originalPath).toBeUndefined();
    expect(body.entry.compressedPath).toBeUndefined();
    expect(body.sourceMetadata.fullPath).toBe("/source/recording.wav");
    expect(body.duplicates[0].duplicatePath).toBe("/duplicates/recording-copy.wav");
  });
});
