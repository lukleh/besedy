import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  });
  return {
    loadCatalogHashes: vi.fn(),
    db: {
      recorder: model(), location: model(), album: model(),
      audioMetadata: { count: vi.fn() }, catalogEvent: { count: vi.fn() },
      $queryRaw: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ default: mocks.db }));
vi.mock("@/lib/catalog", () => ({ loadCatalogHashes: mocks.loadCatalogHashes }));
vi.mock("@/lib/auth/permissions", () => ({ requireAuth: vi.fn(async () => "user-1") }));
vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(async () => ({ canManageLookups: true })),
}));
vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveCatalogWithAccess: vi.fn(async () => ({ group: { id: "20251222_144441" }, hasAccess: true })),
}));

import {
  recorderCollectionHandlers, recorderItemHandlers,
  locationCollectionHandlers, locationItemHandlers,
  albumCollectionHandlers, albumItemHandlers,
} from "@/lib/api/crud-factory";

const CATALOG = "20251222_144441";
const resources = [
  { name: "recorder", collection: recorderCollectionHandlers, item: recorderItemHandlers },
  { name: "location", collection: locationCollectionHandlers, item: locationItemHandlers },
  { name: "album", collection: albumCollectionHandlers, item: albumItemHandlers },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadCatalogHashes.mockRejectedValue(new Error("Catalog hashes must not be enumerated"));
  mocks.db.audioMetadata.count.mockResolvedValue(0);
  mocks.db.catalogEvent.count.mockResolvedValue(0);
  for (const { name } of resources) {
    mocks.db[name].findFirst.mockResolvedValue({ id: 5 });
    mocks.db[name].create.mockResolvedValue({ id: 5, name: "Name" });
    mocks.db[name].update.mockResolvedValue({ id: 5, name: "Name" });
    mocks.db[name].delete.mockResolvedValue({ id: 5 });
  }
});

describe.each(resources)("$name lookup query scope", ({ name, collection, item }) => {
  it.each(["POST", "PUT", "DELETE"] as const)("%s does not enumerate catalog hashes", async (method) => {
    const request = new NextRequest(`http://localhost/api/catalogs/${CATALOG}/metadata/${name}s/5`, {
      method,
      ...(method !== "DELETE" ? {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Name" }),
      } : {}),
    });
    const params = { params: Promise.resolve({ id: CATALOG, itemId: "5" }) };
    const response = method === "POST"
      ? await collection.POST(request, params)
      : await item[method](request, params);

    expect(response.status).toBe(method === "POST" ? 201 : 200);
    expect(mocks.loadCatalogHashes).not.toHaveBeenCalled();
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
  });

  it("counts references in the database without sending catalog hashes back", async () => {
    mocks.db[name].findMany.mockResolvedValue([{ id: 5, name: "Used" }, { id: 6, name: "Unused" }]);
    mocks.db.$queryRaw.mockResolvedValue([{ id: 5, count: 7 }]);
    const response = await collection.GET(
      new NextRequest(`http://localhost/api/catalogs/${CATALOG}/metadata/${name}s`),
      { params: Promise.resolve({ id: CATALOG }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 5, name: "Used", _count: { audioMetadata: 7 } },
      { id: 6, name: "Unused", _count: { audioMetadata: 0 } },
    ]);
    expect(mocks.loadCatalogHashes).not.toHaveBeenCalled();
    expect(mocks.db.$queryRaw).toHaveBeenCalledOnce();
    const query = mocks.db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toEqual([CATALOG]);
    expect(query.sql).toContain(`m.${name}_id AS id`);
    expect(query.sql).toContain("e.workflow_group_id = m.workflow_group_id AND e.audio_hash = m.audio_hash");
    expect(query.sql).toContain("WHERE m.workflow_group_id = ?");
  });
});
