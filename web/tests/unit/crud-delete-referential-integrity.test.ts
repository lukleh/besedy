import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  // errors.ts checks `error instanceof AuthError`; provide a real class so the
  // instanceof check works and plain Prisma-shaped errors fall through.
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    audioMetadata: { count: vi.fn() },
    catalogEvent: { count: vi.fn() },
    recorder: { delete: vi.fn(), findFirst: vi.fn() },
    location: { delete: vi.fn(), findFirst: vi.fn() },
    album: { delete: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/catalog", () => ({ loadCatalogHashes: vi.fn() }));

vi.mock("@/lib/catalog/resolve-group", () => ({
  resolveActiveGroupWithAccess: vi.fn(),
}));

import {
  recorderItemHandlers,
  locationItemHandlers,
  albumItemHandlers,
} from "@/lib/api/crud-factory";
import { handlePrismaError } from "@/lib/api/errors";
import prisma from "@/lib/db";

type Model = { delete: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };

const db = prisma as unknown as {
  audioMetadata: { count: ReturnType<typeof vi.fn> };
  catalogEvent: { count: ReturnType<typeof vi.fn> };
  recorder: Model;
  location: Model;
  album: Model;
};

function deleteRequest() {
  return new NextRequest("http://localhost/api/x/5", { method: "DELETE" });
}
const params = () => ({ params: Promise.resolve({ id: "5" }) });

describe("CRUD delete referential-integrity guards", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
    const { requireAuth } = await import("@/lib/auth/permissions");
    const { getCatalogCapability } = await import("@/lib/access/capabilities");
    const { loadCatalogHashes } = await import("@/lib/catalog");
    const { resolveActiveGroupWithAccess } = await import("@/lib/catalog/resolve-group");
    // An editor of the one catalog the row lives in; the guards under test are
    // referential, not authorizational.
    asMock(requireAuth).mockResolvedValue("user-1");
    asMock(resolveActiveGroupWithAccess).mockResolvedValue({
      group: { id: "20251222_144441" },
      hasAccess: true,
    });
    asMock(loadCatalogHashes).mockResolvedValue(new Set<string>());
    asMock(getCatalogCapability).mockResolvedValue({ canEditMetadata: true });
    for (const model of [db.recorder, db.location, db.album]) {
      model.findFirst.mockResolvedValue({ id: 5 });
    }
  });

  it("blocks deleting a recorder still referenced by recordings (409)", async () => {
    db.audioMetadata.count.mockResolvedValue(2);
    const res = await recorderItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(409);
    expect(db.recorder.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced recorder", async () => {
    db.audioMetadata.count.mockResolvedValue(0);
    db.recorder.delete.mockResolvedValue({});
    const res = await recorderItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(200);
    expect(db.recorder.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  it("blocks deleting a location referenced by recordings or events (409)", async () => {
    db.audioMetadata.count.mockResolvedValue(0);
    db.catalogEvent.count.mockResolvedValue(1);
    const res = await locationItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(409);
    expect(db.location.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced location", async () => {
    db.audioMetadata.count.mockResolvedValue(0);
    db.catalogEvent.count.mockResolvedValue(0);
    db.location.delete.mockResolvedValue({});
    const res = await locationItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(200);
    expect(db.location.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  it("blocks deleting an album still referenced by recordings (409)", async () => {
    db.audioMetadata.count.mockResolvedValue(3);
    const res = await albumItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(409);
    expect(db.album.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced album", async () => {
    db.audioMetadata.count.mockResolvedValue(0);
    db.album.delete.mockResolvedValue({});
    const res = await albumItemHandlers.DELETE(deleteRequest(), params());
    expect(res.status).toBe(200);
    expect(db.album.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

describe("handlePrismaError delete FK backstop", () => {
  it("maps a P2003 foreign-key violation on delete to 409", async () => {
    const res = handlePrismaError({ code: "P2003" }, "recorder", "delete");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Cannot delete recorder");
  });

  it("does not treat a P2003 on a non-delete operation as a delete conflict", async () => {
    // P2003 on create is a normal FK-not-found error, not a delete conflict.
    const res = handlePrismaError({ code: "P2003" }, "recorder", "create");
    const body = await res.json();
    expect(body.error).toContain("Related record not found");
  });
});
