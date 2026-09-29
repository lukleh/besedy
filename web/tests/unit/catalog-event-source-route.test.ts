import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { canManageEventSources } from "@/lib/policy/event";
import { GET as getEventSource } from "@/app/api/catalogs/[id]/events/[eventId]/sources/[sourceId]/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/event-sources", () => ({
  readEventSources: vi.fn(),
  resolveEventSourcesDir: vi.fn(),
  writeEventSources: vi.fn(),
}));

vi.mock("@/lib/security/path-validation", () => ({
  validatePathAsync: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findFirst: vi.fn(),
    },
  },
}));

describe("catalog event source route", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;
  const sourceId = "source-1";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let readEventSources: ReturnType<typeof vi.fn>;
  let resolveEventSourcesDir: ReturnType<typeof vi.fn>;
  let validatePathAsync: ReturnType<typeof vi.fn>;
  let tmpDir: string;
  let prisma: {
    catalogEvent: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    requireCatalogEventsAccess = (
      await import("@/lib/catalog-events/access")
    ).requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    requireCatalogManagementAccess = (
      await import("@/lib/access/catalog-management-route-access")
    ).requireCatalogManagementAccess as ReturnType<typeof vi.fn>;
    readEventSources = (await import("@/lib/event-sources")).readEventSources as ReturnType<
      typeof vi.fn
    >;
    resolveEventSourcesDir = (await import("@/lib/event-sources"))
      .resolveEventSourcesDir as ReturnType<typeof vi.fn>;
    validatePathAsync = (await import("@/lib/security/path-validation"))
      .validatePathAsync as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "besedy-event-source-"));

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "viewer-1",
    });
    requireCatalogManagementAccess.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Event-sources permission required to manage event sources" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      ),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function grantManagementAccess() {
    requireCatalogManagementAccess.mockResolvedValue({ ok: true, userId: "viewer-1" });
    prisma.catalogEvent.findFirst.mockResolvedValue({ id: eventId });
    resolveEventSourcesDir.mockReturnValue(tmpDir);
  }

  function seedFileSource(storedName: string) {
    readEventSources.mockResolvedValue([
      {
        id: sourceId,
        type: "file",
        storedName,
        originalName: "notes.txt",
        mimeType: "text/plain",
      },
    ]);
    const filePath = path.join(tmpDir, storedName);
    validatePathAsync.mockResolvedValue({ valid: true, resolvedPath: filePath });
    return filePath;
  }

  function getSource() {
    return getEventSource(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/events/${eventId}/sources/${sourceId}`
      ),
      {
        params: Promise.resolve({
          id: catalogId,
          eventId: String(eventId),
          sourceId,
        }),
      }
    );
  }

  it("streams a readable file source with an error listener attached", async () => {
    grantManagementAccess();
    const filePath = seedFileSource("notes.txt");
    fs.writeFileSync(filePath, "hello");
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");

    try {
      const response = await getSource();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe("5");
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
      const stream = createReadStreamSpy.mock.results[0]?.value as fs.ReadStream;
      expect(stream.listenerCount("error")).toBeGreaterThan(0);
      await expect(response.text()).resolves.toBe("hello");
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it("returns 404 without opening a stream when the file source is missing", async () => {
    grantManagementAccess();
    seedFileSource("missing.txt");
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");

    try {
      const response = await getSource();

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "File not found" });
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it("returns 500 without opening a stream when the file source is not readable", async () => {
    grantManagementAccess();
    const filePath = seedFileSource("notes.txt");
    fs.writeFileSync(filePath, "hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const accessSpy = vi.spyOn(fs.promises, "access").mockRejectedValue(
      Object.assign(new Error(`EACCES: permission denied, access '${filePath}'`), {
        code: "EACCES",
      })
    );
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");

    try {
      const response = await getSource();

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Source file is not readable" });
      expect(createReadStreamSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    } finally {
      errorSpy.mockRestore();
      accessSpy.mockRestore();
      createReadStreamSpy.mockRestore();
    }
  });

  it("returns 403 when the user cannot manage an event source", async () => {
    const response = await getEventSource(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/events/${eventId}/sources/${sourceId}`
      ),
      {
        params: Promise.resolve({
          id: catalogId,
          eventId: String(eventId),
          sourceId,
        }),
      }
    );

    expect(response.status).toBe(403);
    expect(requireCatalogManagementAccess).toHaveBeenCalledWith(catalogId, {
      userId: "viewer-1",
      auditResource: "event_sources",
      auditResourceId: String(eventId),
      deniedMessage: "Event-sources permission required to manage event sources",
      deniedReason: "Event-sources permission required to manage event sources",
      authorize: canManageEventSources,
    });
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
    expect(readEventSources).not.toHaveBeenCalled();
  });
});
