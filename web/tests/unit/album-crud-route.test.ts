import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAlbums, POST as postAlbum } from "@/app/api/metadata/albums/route";
import { PUT as putAlbum } from "@/app/api/metadata/albums/[id]/route";

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
  resolveActiveGroupWithAccess: vi.fn(),
}));

describe("album CRUD routes", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let resolveActiveGroupWithAccess: ReturnType<typeof vi.fn>;
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
    resolveActiveGroupWithAccess = (
      await import("@/lib/catalog/resolve-group")
    ).resolveActiveGroupWithAccess as ReturnType<typeof vi.fn>;
    loadCatalogHashes = (await import("@/lib/catalog")).loadCatalogHashes as ReturnType<typeof vi.fn>;
  });

  /** Put the caller in one catalog, optionally with edit rights on it. */
  function inCatalog(canEditMetadata: boolean) {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveActiveGroupWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: true,
    });
    vi.mocked(loadCatalogHashes).mockResolvedValue(new Set(["hash1"]));
    vi.mocked(getCatalogCapability).mockResolvedValue({ canEditMetadata });
  }

  it("GET /api/metadata/albums returns album list", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveActiveGroupWithAccess).mockResolvedValue({
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

    vi.mocked(getCatalogCapability).mockResolvedValue({ canEditMetadata: false });

    const request = new NextRequest("http://localhost/api/metadata/albums");
    const response = await getAlbums(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].name).toBe("Album A");
    expect(body[0]._count.audioMetadata).toBe(5);
    expect(prisma.album.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workflowGroupId: "20251222_144441" } })
    );
  });

  it("GET /api/metadata/albums returns 403 without catalog access", async () => {
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(resolveActiveGroupWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: false,
    });

    const request = new NextRequest("http://localhost/api/metadata/albums");
    const response = await getAlbums(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Catalog access required/);
  });

  it("POST /api/metadata/albums trims name and files it under the catalog", async () => {
    inCatalog(true);
    prisma.album.create.mockResolvedValue({
      id: 2,
      name: "Album B",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const request = new NextRequest("http://localhost/api/metadata/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Album B  " }),
    });

    const response = await postAlbum(request);

    expect(response.status).toBe(201);
    expect(prisma.album.create).toHaveBeenCalledWith({
      data: { name: "Album B", workflowGroupId: "20251222_144441" },
    });
  });

  it("POST /api/metadata/albums refuses a reader of the catalog", async () => {
    inCatalog(false);

    const request = new NextRequest("http://localhost/api/metadata/albums", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Album C" }),
    });

    const response = await postAlbum(request);

    expect(response.status).toBe(403);
    expect(prisma.album.create).not.toHaveBeenCalled();
  });

  it("PUT /api/metadata/albums/:id rejects empty names", async () => {
    inCatalog(true);

    const request = new NextRequest("http://localhost/api/metadata/albums/1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });

    const response = await putAlbum(request, { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Name is required/);
  });

  it("PUT /api/metadata/albums/:id will not reach a row in another catalog", async () => {
    inCatalog(true);
    prisma.album.findFirst.mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/metadata/albums/99", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    const response = await putAlbum(request, { params: Promise.resolve({ id: "99" }) });

    expect(response.status).toBe(404);
    expect(prisma.album.update).not.toHaveBeenCalled();
  });
});
