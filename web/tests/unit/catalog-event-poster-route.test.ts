import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GET as getEventPoster,
  POST as uploadEventPoster,
} from "@/app/api/catalogs/[id]/events/[eventId]/poster/route";

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("sharp", () => ({
  default: vi.fn(),
}));

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/event-posters", () => ({
  findPosterFile: vi.fn(),
  getPosterContentType: vi.fn(),
  POSTER_EXTENSIONS: [".jpg", ".jpeg", ".png"],
  removeExistingPosterFiles: vi.fn(),
  resolveEventPosterDir: vi.fn(),
  writePosterMeta: vi.fn(),
}));

vi.mock("@/lib/security/path-validation", () => ({
  validatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findFirst: vi.fn(),
    },
  },
}));

describe("catalog event poster route", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let isPublishedVisibleEvent: ReturnType<typeof vi.fn>;
  let findPosterFile: ReturnType<typeof vi.fn>;
  let getPosterContentType: ReturnType<typeof vi.fn>;
  let resolveEventPosterDir: ReturnType<typeof vi.fn>;
  let writePosterMeta: ReturnType<typeof vi.fn>;
  let validatePath: ReturnType<typeof vi.fn>;
  let sharp: ReturnType<typeof vi.fn>;
  let fs: {
    mkdir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
  };
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
    isPublishedVisibleEvent = (
      await import("@/lib/catalog-events/visibility")
    ).isPublishedVisibleEvent as ReturnType<typeof vi.fn>;
    findPosterFile = (await import("@/lib/event-posters")).findPosterFile as ReturnType<
      typeof vi.fn
    >;
    getPosterContentType = (
      await import("@/lib/event-posters")
    ).getPosterContentType as ReturnType<typeof vi.fn>;
    resolveEventPosterDir = (
      await import("@/lib/event-posters")
    ).resolveEventPosterDir as ReturnType<typeof vi.fn>;
    writePosterMeta = (await import("@/lib/event-posters")).writePosterMeta as ReturnType<
      typeof vi.fn
    >;
    validatePath = (
      await import("@/lib/security/path-validation")
    ).validatePath as ReturnType<typeof vi.fn>;
    sharp = (await import("sharp")).default as unknown as ReturnType<typeof vi.fn>;
    fs = (await import("fs/promises")).default as unknown as typeof fs;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "viewer-1",
      accessLevel: "VIEWER",
    });
    requireCatalogManagementAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Access denied to this poster" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    });
    isPublishedVisibleEvent.mockResolvedValue(true);
    findPosterFile.mockResolvedValue("/tmp/poster.jpg");
    getPosterContentType.mockReturnValue("image/jpeg");
    resolveEventPosterDir.mockReturnValue("/tmp/posters");
    validatePath.mockReturnValue({ valid: true, resolvedPath: "/tmp/poster.jpg" });
    fs.mkdir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue(Buffer.from("poster"));
    fs.writeFile.mockResolvedValue(undefined);
    prisma.catalogEvent.findFirst.mockResolvedValue({ id: eventId });
  });

  it("returns 403 when the user cannot manage event posters", async () => {
    const response = await uploadEventPoster(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(403);
    expect(requireCatalogManagementAccess).toHaveBeenCalledWith(catalogId, {
      userId: "viewer-1",
      auditResource: "event_poster",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to this poster",
      deniedReason: "Not owner/admin",
    });
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
  });

  it("keeps draft poster previews accessible for owners", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });

    const response = await getEventPoster(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster?variant=portrait`
      ),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    expect(isPublishedVisibleEvent).not.toHaveBeenCalled();
    expect(prisma.catalogEvent.findFirst).toHaveBeenCalledWith({
      where: { id: eventId, workflowGroupId: catalogId },
      select: { id: true },
    });
  });

  it("returns 404 for listener draft poster previews", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      accessLevel: "LISTENER",
    });
    isPublishedVisibleEvent.mockResolvedValue(false);

    const response = await getEventPoster(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster?variant=portrait`
      ),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(404);
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
  });

  it("rejects poster bytes that Sharp cannot fully decode", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    requireCatalogManagementAccess.mockResolvedValue({ ok: true });

    const stats = vi.fn().mockRejectedValue(new Error("invalid pixel data"));
    const clone = vi.fn().mockReturnValue({ stats });
    const metadata = vi.fn().mockResolvedValue({
      format: "jpeg",
      width: 100,
      height: 100,
    });
    const rotate = vi.fn().mockReturnValue({ clone, metadata });
    sharp.mockReturnValue({ rotate });

    const posterFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("not-a-jpeg")),
      name: "poster.jpg",
      size: 10,
      type: "image/jpeg",
    };
    const formData = {
      get: vi.fn((name: string) => (name === "portrait" ? posterFile : null)),
    } as unknown as FormData;

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`,
      { method: "POST" }
    );
    vi.spyOn(request, "formData").mockResolvedValue(formData);

    const response = await uploadEventPoster(
      request,
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_FILE",
    });
    expect(sharp).toHaveBeenCalledWith(expect.any(Buffer), {
      failOn: "warning",
      limitInputPixels: 50_000_000,
    });
    expect(stats).toHaveBeenCalledOnce();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(writePosterMeta).not.toHaveBeenCalled();
  });

  it("returns 400 when a poster exceeds Sharp's pixel budget", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    requireCatalogManagementAccess.mockResolvedValue({ ok: true });

    const metadata = vi
      .fn()
      .mockRejectedValue(new Error("Input image exceeds pixel limit"));
    const rotate = vi.fn().mockReturnValue({ metadata });
    sharp.mockReturnValue({ rotate });

    const posterFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("oversized-png")),
      name: "poster.png",
      size: 13,
      type: "image/png",
    };
    const formData = {
      get: vi.fn((name: string) => (name === "portrait" ? posterFile : null)),
    } as unknown as FormData;

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`,
      { method: "POST" }
    );
    vi.spyOn(request, "formData").mockResolvedValue(formData);

    const response = await uploadEventPoster(request, {
      params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_FILE",
      error:
        "Poster files must contain valid JPG or PNG image data and not exceed 50 megapixels",
    });
    expect(sharp).toHaveBeenCalledWith(expect.any(Buffer), {
      failOn: "warning",
      limitInputPixels: 50_000_000,
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(writePosterMeta).not.toHaveBeenCalled();
  });

  it("rejects poster data that does not match its file extension", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    requireCatalogManagementAccess.mockResolvedValue({ ok: true });

    const metadata = vi.fn().mockResolvedValue({
      format: "svg",
      width: 100,
      height: 100,
    });
    const rotate = vi.fn().mockReturnValue({ metadata });
    sharp.mockReturnValue({ rotate });

    const posterFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("<svg></svg>")),
      name: "poster.jpg",
      size: 11,
      type: "image/jpeg",
    };
    const formData = {
      get: vi.fn((name: string) => (name === "portrait" ? posterFile : null)),
    } as unknown as FormData;

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`,
      { method: "POST" }
    );
    vi.spyOn(request, "formData").mockResolvedValue(formData);

    const response = await uploadEventPoster(request, {
      params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_FILE",
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(writePosterMeta).not.toHaveBeenCalled();
  });

  it("resizes over-dimension posters even when the input is small", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    requireCatalogManagementAccess.mockResolvedValue({ ok: true });

    const outputBuffer = Buffer.from("resized-png");
    const toBuffer = vi.fn().mockResolvedValue(outputBuffer);
    const png = vi.fn().mockReturnValue({ toBuffer });
    const resize = vi.fn().mockReturnValue({ png });
    const metadata = vi.fn().mockResolvedValue({
      format: "png",
      width: 5000,
      height: 5000,
    });
    const rotate = vi.fn().mockReturnValue({ metadata, resize });
    sharp.mockReturnValue({ rotate });

    const posterFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("png")),
      name: "poster.png",
      size: 3,
      type: "image/png",
    };
    const formData = {
      get: vi.fn((name: string) => (name === "portrait" ? posterFile : null)),
    } as unknown as FormData;

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`,
      { method: "POST" }
    );
    vi.spyOn(request, "formData").mockResolvedValue(formData);

    const response = await uploadEventPoster(request, {
      params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
    });

    expect(response.status).toBe(200);
    expect(resize).toHaveBeenCalledWith({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    });
    expect(png).toHaveBeenCalledOnce();
    expect(toBuffer).toHaveBeenCalledOnce();
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("poster_portrait.png"),
      outputBuffer
    );
    expect(writePosterMeta).toHaveBeenCalledOnce();
  });

  it("fully processes the portrait before decoding the landscape", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    requireCatalogManagementAccess.mockResolvedValue({ ok: true });

    let finishPortraitStats!: () => void;
    const portraitStatsPromise = new Promise<void>((resolve) => {
      finishPortraitStats = resolve;
    });
    const portraitStats = vi.fn().mockReturnValue(portraitStatsPromise);
    const portraitClone = vi.fn().mockReturnValue({ stats: portraitStats });
    const portraitMetadata = vi.fn().mockResolvedValue({
      format: "jpeg",
      width: 100,
      height: 100,
    });
    const portraitRotate = vi.fn().mockReturnValue({
      clone: portraitClone,
      metadata: portraitMetadata,
    });

    const landscapeStats = vi.fn().mockResolvedValue(undefined);
    const landscapeClone = vi.fn().mockReturnValue({ stats: landscapeStats });
    const landscapeMetadata = vi.fn().mockResolvedValue({
      format: "jpeg",
      width: 100,
      height: 100,
    });
    const landscapeRotate = vi.fn().mockReturnValue({
      clone: landscapeClone,
      metadata: landscapeMetadata,
    });

    sharp
      .mockReturnValueOnce({ rotate: portraitRotate })
      .mockReturnValueOnce({ rotate: landscapeRotate });

    const portraitFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("portrait")),
      name: "portrait.jpg",
      size: 8,
      type: "image/jpeg",
    };
    const landscapeFile = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("landscape")),
      name: "landscape.jpg",
      size: 9,
      type: "image/jpeg",
    };
    const formData = {
      get: vi.fn((name: string) => {
        if (name === "portrait") return portraitFile;
        if (name === "landscape") return landscapeFile;
        return null;
      }),
    } as unknown as FormData;

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster`,
      { method: "POST" }
    );
    vi.spyOn(request, "formData").mockResolvedValue(formData);

    const responsePromise = uploadEventPoster(request, {
      params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
    });

    await vi.waitFor(() => expect(portraitStats).toHaveBeenCalledOnce());
    expect(landscapeFile.arrayBuffer).not.toHaveBeenCalled();

    finishPortraitStats();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(landscapeFile.arrayBuffer).toHaveBeenCalledOnce();
    expect(landscapeStats).toHaveBeenCalledOnce();
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });
});
