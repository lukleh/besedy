import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogRoute } from "@/app/api/catalogs/[id]/recordings/route";
import { GET as getFilterOptionsRoute } from "@/app/api/catalogs/[id]/recordings/filter-options/route";
import type { EnrichedCatalogEntry } from "@/lib/catalog";
import { grantForRole } from "@/lib/policy/catalog-permissions";

const CATALOG = "20251225_120000";
const getCatalog = (request: NextRequest) =>
  getCatalogRoute(request, { params: Promise.resolve({ id: CATALOG }) });
const getFilterOptions = (request: NextRequest) =>
  getFilterOptionsRoute(request, { params: Promise.resolve({ id: CATALOG }) });

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
    loadCatalogSelectionEntries: vi.fn(),
    loadEnrichedCatalogEntries: vi.fn(),
  };
});

vi.mock("@/lib/catalog/resolve-group", () => ({
  findActiveCatalog: vi.fn(),
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
  let findActiveCatalog: ReturnType<typeof vi.fn>;
  let loadEnrichedCatalogEntries: ReturnType<typeof vi.fn>;
  let loadCatalogSelectionEntries: ReturnType<typeof vi.fn>;
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
    findActiveCatalog = groupModule.findActiveCatalog as ReturnType<typeof vi.fn>;
    const catalogModule = await import("@/lib/catalog");
    loadEnrichedCatalogEntries =
      catalogModule.loadEnrichedCatalogEntries as ReturnType<typeof vi.fn>;
    loadCatalogSelectionEntries =
      catalogModule.loadCatalogSelectionEntries as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  function mockEntries(entries: EnrichedCatalogEntry[]) {
    loadCatalogSelectionEntries.mockResolvedValue(entries);
    loadEnrichedCatalogEntries.mockImplementation((_groupId: string, hashes: string[]) =>
      entries.filter((entry) => hashes.includes(entry.hash))
    );
  }

  function mockAccessibleCatalog(entries: EnrichedCatalogEntry[]) {
    requireAuth.mockResolvedValue("user-1");
    findActiveCatalog.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      catalogGrant: grantForRole("curator"),
      canBrowseRecordings: true,
      canDownload: true,
      canEditMetadata: true,
      canBatchEditMetadata: true,
      canManageAccess: true,
    });
    mockEntries(entries);
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

  it("GET /api/catalogs/:id/recordings returns 403 when user lacks catalog access", async () => {
    requireAuth.mockResolvedValue("user-1");
    findActiveCatalog.mockResolvedValue({ id: "20251225_120000" });
    getCatalogCapability.mockResolvedValue({ hasAccess: false });

    const request = new NextRequest("http://localhost/api/catalogs/20251225_120000/recordings");
    const response = await getCatalog(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
  });

  it("GET /api/catalogs/:id/recordings/filter-options returns 403 when user lacks catalog access", async () => {
    requireAuth.mockResolvedValue("user-1");
    findActiveCatalog.mockResolvedValue({ id: "20251225_120000" });
    getCatalogCapability.mockResolvedValue({ hasAccess: false });

    const request = new NextRequest("http://localhost/api/catalogs/20251225_120000/recordings/filter-options");
    const response = await getFilterOptions(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
  });

  it("GET /api/catalogs/:id/recordings scopes listener rows, counts, and filters to visible entries", async () => {
    requireAuth.mockResolvedValue("listener-1");
    findActiveCatalog.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      // Browsing the list is its own permission now, and no role below the
      // curator carries it. This is the grant the scoping below exists for:
      // an account given the list as an extra, which still cannot see
      // unreleased material.
      catalogGrant: { role: "listener", extras: ["browse_recordings"] },
      canBrowseRecordings: true,
      canDownload: false,
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageAccess: false,
    });
    mockEntries([
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
      "http://localhost/api/catalogs/20251225_120000/recordings?status=incomplete"
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

  it("GET /api/catalogs/:id/recordings/filter-options scopes listener options to visible entries", async () => {
    requireAuth.mockResolvedValue("listener-1");
    findActiveCatalog.mockResolvedValue({
      id: "20251225_120000",
      label: "Winter Catalog",
      createdAt: new Date("2025-12-25T12:00:00.000Z"),
      updatedAt: new Date("2025-12-26T08:30:00.000Z"),
    });
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      catalogGrant: { role: "listener", extras: ["browse_recordings"] },
      canBrowseRecordings: true,
    });
    mockEntries([
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
      "http://localhost/api/catalogs/20251225_120000/recordings/filter-options"
    );
    const response = await getFilterOptions(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalMatching).toBe(1);
    expect(body.options.statuses).toEqual([]);
    expect(body.options.recorders).toEqual([
      { id: 1, name: "Visible Recorder", count: 1 },
    ]);
    expect(loadEnrichedCatalogEntries).not.toHaveBeenCalled();
  });

  it("enriches only the requested page and retains its selected order", async () => {
    mockAccessibleCatalog(createMatrixEntries());
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings?sort=title&dir=desc&page=1&limit=2`
    ));
    const body = await response.json();

    expect(body.entries.map((entry: { hash: string }) => entry.hash)).toEqual([
      "c".repeat(64), "b".repeat(64),
    ]);
    expect(loadEnrichedCatalogEntries).toHaveBeenCalledExactlyOnceWith(CATALOG, [
      "c".repeat(64), "b".repeat(64),
    ]);
    expect(body).toMatchObject({ totalAll: 3, total: 3, actionable: 2, verified: 1 });
    expect(body.pagination).toEqual({ page: 1, limit: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false });
    expect(body.filters.parts).toEqual([1, 2]);
  });

  it("keeps the explicit all-recordings request", async () => {
    mockAccessibleCatalog(createMatrixEntries());
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings?limit=0`
    ));
    const body = await response.json();
    expect(body.entries).toHaveLength(3);
    expect(loadEnrichedCatalogEntries).toHaveBeenCalledExactlyOnceWith(CATALOG, [
      "b".repeat(64), "a".repeat(64), "c".repeat(64),
    ]);
    expect(body.pagination).toEqual({ page: 1, limit: 3, totalPages: 1, hasNextPage: false, hasPrevPage: false });
  });

  it("loads only the later page's details", async () => {
    mockAccessibleCatalog(createMatrixEntries());
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings?page=2&limit=2`
    ));
    const body = await response.json();
    expect(body.entries.map((entry: { hash: string }) => entry.hash)).toEqual(["c".repeat(64)]);
    expect(loadEnrichedCatalogEntries).toHaveBeenCalledExactlyOnceWith(CATALOG, ["c".repeat(64)]);
    expect(body.pagination).toEqual({ page: 2, limit: 2, totalPages: 2, hasNextPage: false, hasPrevPage: true });
  });

  it.each([
    ["asc", ["c", "b", "a"]],
    ["desc", ["a", "b", "c"]],
  ])("keeps natural, accent-insensitive source-title ordering %s", async (dir, hashes) => {
    mockAccessibleCatalog([
      createEntry({ hash: "a".repeat(64), title: "Talk 10", curatedTitle: "A" }),
      createEntry({ hash: "b".repeat(64), title: "Tálk 2", curatedTitle: "Z" }),
      createEntry({ hash: "c".repeat(64), title: undefined, filename: "Talk 1", curatedTitle: "Y" }),
    ]);
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings?sort=title&dir=${dir}`
    ));
    expect((await response.json()).entries.map((entry: { hash: string }) => entry.hash)).toEqual(
      hashes.map((hash) => hash.repeat(64)),
    );
  });

  it.each([
    ["asc", ["a", "d", "c", "b"]],
    ["desc", ["c", "d", "a", "b"]],
  ])("keeps partial curated dates, source fallback, and missing dates last %s", async (dir, hashes) => {
    mockAccessibleCatalog([
      createEntry({ hash: "a".repeat(64), date: "2025-12-31", dateYear: 2020, dateMonth: null, dateDay: null }),
      createEntry({ hash: "b".repeat(64), date: "2019-02-03", dateYear: null, dateMonth: 6, dateDay: null }),
      createEntry({ hash: "c".repeat(64), date: "notes from 2024", dateYear: null, dateMonth: null, dateDay: null }),
      createEntry({ hash: "d".repeat(64), date: "3.4.2023", dateYear: null, dateMonth: null, dateDay: null }),
    ]);
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings?sort=date&dir=${dir}`
    ));
    expect((await response.json()).entries.map((entry: { hash: string }) => entry.hash)).toEqual(
      hashes.map((hash) => hash.repeat(64)),
    );
  });

  it("rechecks recording visibility when publication changes after page selection", async () => {
    mockAccessibleCatalog(createMatrixEntries());
    getCatalogCapability.mockResolvedValue({
      hasAccess: true,
      catalogGrant: { role: "listener", extras: ["browse_recordings"] },
      canBrowseRecordings: true,
    });
    loadEnrichedCatalogEntries.mockResolvedValue([
      createEntry({ hash: "a".repeat(64), isPublished: false }),
    ]);
    const response = await getCatalog(new NextRequest(
      `http://localhost/api/catalogs/${CATALOG}/recordings`
    ));
    expect((await response.json()).entries).toEqual([]);
    expect(loadEnrichedCatalogEntries).toHaveBeenCalledExactlyOnceWith(CATALOG, ["a".repeat(64)]);
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
  ])("GET /api/catalogs/:id/recordings applies filter %s", async (query, expectedHashes) => {
    mockAccessibleCatalog(createMatrixEntries());

    const request = new NextRequest(`http://localhost/api/catalogs/20251225_120000/recordings?${query}`);
    const response = await getCatalog(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { hash: string }) => entry.hash)).toEqual(expectedHashes);
  });

  it("GET /api/catalogs/:id/recordings sorts by duplicates descending", async () => {
    mockAccessibleCatalog(createMatrixEntries());

    const request = new NextRequest(
      "http://localhost/api/catalogs/20251225_120000/recordings?sort=duplicates&dir=desc"
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
    "GET /api/catalogs/:id/recordings ignores invalid %s query values",
    async (param, value) => {
      mockAccessibleCatalog(createMatrixEntries());

      const request = new NextRequest(
        `http://localhost/api/catalogs/20251225_120000/recordings?${param}=${encodeURIComponent(value)}`
      );
      const response = await getCatalog(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.total).toBe(3);
      expect(body.entries).toHaveLength(3);
    }
  );
});
