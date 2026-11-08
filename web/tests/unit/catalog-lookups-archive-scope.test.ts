import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  });
  return {
    db: {
      workflowGroup: { findUnique: vi.fn(), findFirst: vi.fn() },
      recorder: model(), location: model(), album: model(),
      $queryRaw: vi.fn(),
    },
    getAdminCapability: vi.fn(),
    getCatalogCapability: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ default: mocks.db }));
vi.mock("@/lib/auth/permissions", () => ({ requireAuth: async () => "admin-1" }));
vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: mocks.getAdminCapability,
  getCatalogCapability: mocks.getCatalogCapability,
}));

// Keep the archive resolver, shared scope resolver and CRUD handlers real.
import {
  recorderCollectionHandlers, recorderItemHandlers,
  locationCollectionHandlers, locationItemHandlers,
  albumCollectionHandlers, albumItemHandlers,
} from "@/lib/api/crud-factory";

const ARCHIVE = "20251225_120000";
const FOREIGN = "20260101_120000";
const resources = [
  { name: "recorder", collection: recorderCollectionHandlers, item: recorderItemHandlers },
  { name: "location", collection: locationCollectionHandlers, item: locationItemHandlers },
  { name: "album", collection: albumCollectionHandlers, item: albumItemHandlers },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BESEDY_ARCHIVE_ID", ARCHIVE);
  mocks.db.workflowGroup.findUnique.mockResolvedValue({ id: ARCHIVE, label: "Archive", isActive: true });
  mocks.db.workflowGroup.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, isActive: true }));
  mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  mocks.getCatalogCapability.mockImplementation(async (id) => ({
    hasAccess: id === ARCHIVE,
    canManageLookups: id === ARCHIVE,
  }));
  mocks.db.$queryRaw.mockResolvedValue([]);
  for (const { name } of resources) {
    mocks.db[name].findMany.mockResolvedValue([{ id: 5, name: "Saved lookup" }]);
    mocks.db[name].findFirst.mockResolvedValue({ id: 5, name: "Saved lookup" });
  }
});

describe.each(resources)("$name archive boundary", ({ name, collection, item }) => {
  it.each(["collection", "item"] as const)("hides a foreign %s even from an administrator", async (kind) => {
    const response = await (kind === "collection" ? collection : item).GET(
      new NextRequest(`http://localhost/api/catalogs/${FOREIGN}/metadata/${name}s/5`),
      { params: Promise.resolve({ id: FOREIGN, itemId: "5" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.db[name].findMany).not.toHaveBeenCalled();
    expect(mocks.db[name].findFirst).not.toHaveBeenCalled();
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["collection", "item"] as const)("keeps bound archive %s reads working", async (kind) => {
    const response = await (kind === "collection" ? collection : item).GET(
      new NextRequest(`http://localhost/api/catalogs/${ARCHIVE}/metadata/${name}s/5`),
      { params: Promise.resolve({ id: ARCHIVE, itemId: "5" }) },
    );

    expect(response.status).toBe(200);
    const query = kind === "collection" ? mocks.db[name].findMany : mocks.db[name].findFirst;
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workflowGroupId: ARCHIVE }),
    }));
  });

  it("keeps an ordinary user's missing access denied", async () => {
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: false });
    mocks.getCatalogCapability.mockResolvedValue({ hasAccess: false, canManageLookups: false });
    const response = await collection.GET(
      new NextRequest(`http://localhost/api/catalogs/${ARCHIVE}/metadata/${name}s`),
      { params: Promise.resolve({ id: ARCHIVE }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.db[name].findMany).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE"] as const)("keeps foreign %s mutations unavailable", async (method) => {
    const request = new NextRequest(`http://localhost/api/catalogs/${FOREIGN}/metadata/${name}s/5`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method !== "DELETE" ? { body: JSON.stringify({ name: "Changed" }) } : {}),
    });
    const params = { params: Promise.resolve({ id: FOREIGN, itemId: "5" }) };
    const response = method === "POST"
      ? await collection.POST(request, params)
      : await item[method](request, params);
    expect(response.status).toBe(404);
    expect(mocks.db[name].create).not.toHaveBeenCalled();
    expect(mocks.db[name].update).not.toHaveBeenCalled();
    expect(mocks.db[name].delete).not.toHaveBeenCalled();
  });

  it("reports invalid configuration without returning lookup data", async () => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", "newest");
    const response = await collection.GET(
      new NextRequest(`http://localhost/api/catalogs/${ARCHIVE}/metadata/${name}s`),
      { params: Promise.resolve({ id: ARCHIVE }) },
    );
    expect(response.status).toBe(503);
    expect(mocks.db[name].findMany).not.toHaveBeenCalled();
  });
});
