import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAlbums, POST as postAlbum } from "@/app/api/metadata/albums/route";
import { PUT as putAlbum } from "@/app/api/metadata/albums/[id]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  requireEditorOnAnyCatalog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    album: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
  let requireEditorOnAnyCatalog: ReturnType<typeof vi.fn>;
  let resolveActiveGroupWithAccess: ReturnType<typeof vi.fn>;
  let loadCatalogHashes: ReturnType<typeof vi.fn>;
  let prisma: {
    album: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    audioMetadata: {
      groupBy: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    requireEditorOnAnyCatalog = permissionsModule.requireEditorOnAnyCatalog as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    resolveActiveGroupWithAccess = (
      await import("@/lib/catalog/resolve-group")
    ).resolveActiveGroupWithAccess as ReturnType<typeof vi.fn>;
    loadCatalogHashes = (await import("@/lib/catalog")).loadCatalogHashes as ReturnType<typeof vi.fn>;
  });

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

    const request = new NextRequest("http://localhost/api/metadata/albums");
    const response = await getAlbums(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].name).toBe("Album A");
    expect(body[0]._count.audioMetadata).toBe(5);
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

  it("POST /api/metadata/albums trims name and creates album", async () => {
    vi.mocked(requireEditorOnAnyCatalog).mockResolvedValue("editor-1");
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
    expect(prisma.album.create).toHaveBeenCalledWith({ data: { name: "Album B" } });
  });

  it("PUT /api/metadata/albums/:id rejects empty names", async () => {
    vi.mocked(requireEditorOnAnyCatalog).mockResolvedValue("editor-1");

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
});
