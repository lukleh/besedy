import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalog } from "@/app/api/catalog/route";
import { GET as getFilterOptions } from "@/app/api/catalog/filter-options/route";
import type { EnrichedCatalogEntry } from "@/lib/catalog";

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
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/catalog")>(
    "@/lib/catalog"
  );
  return {
    ...actual,
    loadEnrichedCatalogEntries: vi.fn(),
  };
});

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveActiveGroup: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logCatalogViewed: vi.fn(),
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recorder: { findMany: vi.fn() },
    location: { findMany: vi.fn() },
    album: { findMany: vi.fn() },
  },
}));

function createEntry(overrides: Partial<EnrichedCatalogEntry> = {}): EnrichedCatalogEntry {
  return {
    hash: "a".repeat(64),
    filename: "recording.wav",
    duration: "00:01:00",
    title: "Source Title",
    curatedTitle: null,
    artist: "Source Artist",
    curatedArtist: null,
    albumId: null,
    album: null,
    date: "2024-01-01",
    curatedDate: null,
    dateYear: 2024,
    dateMonth: 1,
    dateDay: 1,
    hasArchived: true,
    hasMetadata: true,
    isActionable: true,
    isPublished: true,
    compressedPath: "/archive/recording.webm",
    originalPath: "/source/recording.wav",
    scanRoot: "/source",
    sourceAlbum: undefined,
    curated: false,
    verified: false,
    verifiedAt: null,
    tags: [],
    notes: null,
    recorderId: null,
    recorder: null,
    locationId: null,
    location: null,
    part: null,
    duplicateCount: 0,
    ...overrides,
  };
}

describe("catalog API routes (access gating)", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let resolveActiveGroup: ReturnType<typeof vi.fn>;
  let loadEnrichedCatalogEntries: ReturnType<typeof vi.fn>;
  let prisma: {
    recorder: { findMany: ReturnType<typeof vi.fn> };
    location: { findMany: ReturnType<typeof vi.fn> };
    album: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getCatalogCapability =
      accessModule.getCatalogCapability as ReturnType<typeof vi.fn>;
    const groupModule = await import("@/lib/catalog/resolve-group");
    resolveActiveGroup = groupModule.resolveActiveGroup as ReturnType<typeof vi.fn>;
    const catalogModule = await import("@/lib/catalog");
    loadEnrichedCatalogEntries =
      catalogModule.loadEnrichedCatalogEntries as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  function mockAccessibleCatalog(entries: EnrichedCatalogEntry[]) {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      accessLevel: "OWNER",
      canDownload: true,
      canEditMetadata: true,
      canBatchEditMetadata: true,
      canManageAccess: true,
    });
    loadEnrichedCatalogEntries.mockResolvedValue(entries);
  }

  function createMatrixEntries(): EnrichedCatalogEntry[] {
    return [
      createEntry({
        hash: "a".repeat(64),
        title: "Alpha",
        artist: "Source Artist A",
        date: "2024-01-01",
        dateYear: 2024,
        dateMonth: 1,
        dateDay: 1,
        duration: "00:05:00",
        isActionable: true,
        isPublished: true,
        verified: false,
        recorderId: 1,
        recorder: { id: 1, name: "Recorder A" },
        locationId: 10,
        location: { id: 10, name: "Location A" },
        albumId: 100,
        album: { id: 100, name: "Album A" },
        part: 1,
        duplicateCount: 0,
      }),
      createEntry({
        hash: "b".repeat(64),
        title: "Beta",
        artist: "Source Artist B",
        curatedArtist: "Curated Artist B",
        date: "2024-05-10",
        dateYear: 2024,
        dateMonth: 5,
        dateDay: 10,
        duration: "00:35:00",
        isActionable: true,
        isPublished: false,
        verified: true,
        recorderId: 2,
        recorder: { id: 2, name: "Recorder B" },
        locationId: 20,
        location: { id: 20, name: "Location B" },
        albumId: 200,
        album: { id: 200, name: "Album B" },
        part: 2,
        duplicateCount: 3,
      }),
      createEntry({
        hash: "c".repeat(64),
        title: "Gamma",
        artist: undefined,
        curatedArtist: null,
        date: "2023-09-15",
        dateYear: null,
        dateMonth: null,
        dateDay: null,
        duration: "01:05:00",
        isActionable: false,
        isPublished: true,
        verified: false,
        recorderId: null,
        recorder: null,
        locationId: null,
        location: null,
        albumId: null,
        album: null,
        part: null,
        duplicateCount: 1,
      }),
    ];
  }

  it("GET /api/catalog returns 403 when user lacks catalog access", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
    getCatalogCapability.mockResolvedValue({ hasAccess: false });

    const request = new NextRequest("http://localhost/api/catalog");
    const response = await getCatalog(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
  });

  it("GET /api/catalog/filter-options returns 403 when user lacks catalog access", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveActiveGroup.mockResolvedValue({ id: "20251225_120000" });
    getCatalogCapability.mockResolvedValue({ hasAccess: false });

    const request = new NextRequest("http://localhost/api/catalog/filter-options");
    const response = await getFilterOptions(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
  });

  it("GET /api/catalog scopes listener rows, counts, and filters to visible entries", async () => {
    requireAuth.mockResolvedValue("listener-1");
    resolveActiveGroup.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      accessLevel: "LISTENER",
      canDownload: false,
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageAccess: false,
    });
    loadEnrichedCatalogEntries.mockResolvedValue([
      createEntry({
        hash: "a".repeat(64),
        part: 1,
        verified: true,
        recorderId: 1,
        recorder: { id: 1, name: "Visible Recorder" },
      }),
      createEntry({
        hash: "b".repeat(64),
        part: 2,
        dateYear: 2024,
        dateMonth: 2,
        dateDay: 2,
      }),
      createEntry({
        hash: "c".repeat(64),
        isPublished: false,
        part: 99,
        verified: true,
        recorderId: 99,
        recorder: { id: 99, name: "Hidden Recorder" },
        dateYear: 1999,
        dateMonth: 9,
        dateDay: 9,
      }),
    ]);

    const request = new NextRequest(
      "http://localhost/api/catalog?group=20251225_120000&status=incomplete"
    );
    const response = await getCatalog(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalAll).toBe(2);
    expect(body.total).toBe(2);
    expect(body.actionable).toBe(2);
    expect(body.verified).toBe(1);
    expect(body.filters.parts).toEqual([1, 2]);
    expect(body.filters.dateParts).toEqual([
      { year: 2024, month: 1, day: 1 },
      { year: 2024, month: 2, day: 2 },
    ]);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].originalPath).toBeUndefined();
    expect(body.entries[0].compressedPath).toBeUndefined();
    expect(body.entries[0].scanRoot).toBeUndefined();
    expect(body.entries[0].hasArchivedAudio).toBe(true);
    expect(body.entries[0].hasOriginalAudio).toBe(true);
  });

  it("GET /api/catalog/filter-options scopes listener options to visible entries", async () => {
    requireAuth.mockResolvedValue("listener-1");
    resolveActiveGroup.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    loadEnrichedCatalogEntries.mockResolvedValue([
      createEntry({
        hash: "a".repeat(64),
        recorderId: 1,
      }),
      createEntry({
        hash: "b".repeat(64),
        isPublished: false,
        recorderId: 99,
      }),
    ]);
    prisma.recorder.findMany.mockResolvedValue([
      { id: 1, name: "Visible Recorder" },
      { id: 99, name: "Hidden Recorder" },
    ]);
    prisma.location.findMany.mockResolvedValue([]);
    prisma.album.findMany.mockResolvedValue([]);

    const request = new NextRequest(
      "http://localhost/api/catalog/filter-options?group=20251225_120000"
    );
    const response = await getFilterOptions(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalMatching).toBe(1);
    expect(body.options.statuses).toEqual([]);
    expect(body.options.recorders).toEqual([
      { id: 1, name: "Visible Recorder", count: 1 },
    ]);
  });

  it.each([
    ["status=ready", ["a".repeat(64)]],
    ["status=incomplete", ["b".repeat(64), "c".repeat(64)]],
    ["verified=true", ["b".repeat(64)]],
    ["artist=curated", ["b".repeat(64)]],
    ["album=200", ["b".repeat(64)]],
    ["duration=long", ["c".repeat(64)]],
    ["recorder=1", ["a".repeat(64)]],
    ["location=20", ["b".repeat(64)]],
    ["part=2", ["b".repeat(64)]],
    ["dateYear=2024&dateMonth=5&dateDay=10", ["b".repeat(64)]],
    ["duplicates=3", ["b".repeat(64)]],
    ["actionable=true", ["b".repeat(64), "a".repeat(64)]],
  ])("GET /api/catalog applies filter %s", async (query, expectedHashes) => {
    mockAccessibleCatalog(createMatrixEntries());

    const request = new NextRequest(`http://localhost/api/catalog?${query}`);
    const response = await getCatalog(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { hash: string }) => entry.hash)).toEqual(expectedHashes);
  });

  it("GET /api/catalog sorts by duplicates descending", async () => {
    mockAccessibleCatalog(createMatrixEntries());

    const request = new NextRequest(
      "http://localhost/api/catalog?sort=duplicates&dir=desc"
    );
    const response = await getCatalog(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { hash: string }) => entry.hash)).toEqual([
      "b".repeat(64),
      "c".repeat(64),
      "a".repeat(64),
    ]);
  });

  it.each([
    ["status", "bogus"],
    ["duration", "tiny"],
    ["verified", "maybe"],
    ["artist", "   "],
    ["album", "oops"],
    ["recorder", "oops"],
    ["location", "oops"],
    ["part", "oops"],
    ["dateYear", "oops"],
    ["dateMonth", "oops"],
    ["dateDay", "oops"],
    ["duplicates", "oops"],
    ["sort", "bogus"],
    ["dir", "sideways"],
    ["actionable", "yes"],
  ])(
    "GET /api/catalog ignores invalid %s query values",
    async (param, value) => {
      mockAccessibleCatalog(createMatrixEntries());

      const request = new NextRequest(
        `http://localhost/api/catalog?${param}=${encodeURIComponent(value)}`
      );
      const response = await getCatalog(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(3);
      expect(body.entries).toHaveLength(3);
    }
  );
});
