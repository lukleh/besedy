import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAlbums, POST as postAlbum } from "@/app/api/catalogs/[id]/metadata/albums/route";
import { PUT as putAlbum } from "@/app/api/catalogs/[id]/metadata/albums/[itemId]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    album: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    audioMetadata: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("@/lib/catalog", () => ({
  loadCatalogHashes: vi.fn(),
}));

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveCatalogWithAccess: vi.fn(),
}));

const collectionParams = { params: Promise.resolve({ id: "20251222_144441" }) };

describe("album CRUD routes", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let resolveCatalogWithAccess: ReturnType<typeof vi.fn>;
  let loadCatalogHashes: ReturnType<typeof vi.fn>;
  let prisma: {
    album: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    audioMetadata: {
      groupBy: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    resolveCatalogWithAccess = (
      await import("@/lib/catalog/resolve-group")
    ).resolveCatalogWithAccess as ReturnType<typeof vi.fn>;
    loadCatalogHashes = (await import("@/lib/catalog")).loadCatalogHashes as ReturnType<typeof vi.fn>;
  });

  /** Put the caller in one catalog, optionally with lookup rights on it. */
  function inCatalog(canManageLookups: boolean) {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveCatalogWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: true,
    });
    vi.mocked(loadCatalogHashes).mockResolvedValue(new Set(["hash1"]));
    vi.mocked(getCatalogCapability).mockResolvedValue({ canManageLookups });
  }

  it("GET /api/catalogs/:id/metadata/albums returns album list", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveCatalogWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: true,
    });
    vi.mocked(loadCatalogHashes).mockResolvedValue(new Set(["hash1", "hash2"]));
    prisma.album.findMany.mockResolvedValue([
      {
        id: 1,
        name: "Album A",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.audioMetadata.groupBy.mockResolvedValue([
      { albumId: 1, _count: { _all: 5 } },
    ]);

    vi.mocked(getCatalogCapability).mockResolvedValue({ canManageLookups: false });

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums");
    const response = await getAlbums(request, collectionParams);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].name).toBe("Album A");
    expect(body[0]._count.audioMetadata).toBe(5);
    expect(prisma.album.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workflowGroupId: "20251222_144441" } })
    );
  });

  it("GET /api/catalogs/:id/metadata/albums returns 403 without catalog access", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveCatalogWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: false,
    });

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums");
    const response = await getAlbums(request, collectionParams);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Catalog access required/);
  });

  it("GET /api/catalogs/:id/metadata/albums returns 404 for a catalog that does not exist", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveCatalogWithAccess).mockResolvedValue({ group: null, hasAccess: false });

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums");
    const response = await getAlbums(request, collectionParams);

    expect(response.status).toBe(404);
    expect(resolveCatalogWithAccess).toHaveBeenCalledWith("20251222_144441", "user-1");
    expect(prisma.album.findMany).not.toHaveBeenCalled();
  });

  it("GET /api/catalogs/:id/metadata/albums rejects a malformed catalog id", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");

    const request = new NextRequest("http://localhost/api/catalogs/nope/metadata/albums");
    const response = await getAlbums(request, { params: Promise.resolve({ id: "nope" }) });

    expect(response.status).toBe(400);
    expect(resolveCatalogWithAccess).not.toHaveBeenCalled();
  });

  it("POST/api/catalogs/:id/metadata/albums trims name and files it under the catalog", async () => {
    inCatalog(true);
    prisma.album.create.mockResolvedValue({
      id: 2,
      name: "Album B",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Album B  " }),
    });

    const response = await postAlbum(request, collectionParams);

    expect(response.status).toBe(201);
    expect(prisma.album.create).toHaveBeenCalledWith({
      data: { name: "Album B", workflowGroupId: "20251222_144441" },
    });
  });

  it("POST /api/catalogs/:id/metadata/albums refuses a reader of the catalog", async () => {
    inCatalog(false);

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Album C" }),
    });

    const response = await postAlbum(request, collectionParams);

    expect(response.status).toBe(403);
    expect(prisma.album.create).not.toHaveBeenCalled();
  });

  it("PUT /api/catalogs/:id/metadata/albums/:itemId rejects empty names", async () => {
    inCatalog(true);

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums/1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });

    const response = await putAlbum(request, { params: Promise.resolve({ id: "20251222_144441", itemId: "1" }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Name is required/);
  });

  it("PUT /api/catalogs/:id/metadata/albums/:itemId will not reach a row in another catalog", async () => {
    inCatalog(true);
    prisma.album.findFirst.mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/catalogs/20251222_144441/metadata/albums/99", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    const response = await putAlbum(request, { params: Promise.resolve({ id: "20251222_144441", itemId: "99" }) });

    expect(response.status).toBe(404);
    expect(prisma.album.update).not.toHaveBeenCalled();
  });
});
