import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getPublishedArtwork } from "@/app/api/catalogs/[id]/events/[eventId]/artwork/route";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";
import {
  GET as listArtworkCandidates,
  POST as createArtworkCandidate,
} from "@/app/api/catalogs/[id]/events/[eventId]/artworks/route";
import {
  DELETE as unpublishArtwork,
  PUT as publishArtwork,
} from "@/app/api/catalogs/[id]/events/[eventId]/artwork-publication/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock("@/lib/event-artwork-access", () => ({
  requireEventArtworkAccess: vi.fn(),
}));

vi.mock("@/lib/event-artwork-service", () => ({
  EventArtworkServiceError: class EventArtworkServiceError extends Error {
    constructor(
      message: string,
      public statusCode: number
    ) {
      super(message);
    }
  },
  createEventArtworkCandidate: vi.fn(),
  listEventArtworkCandidates: vi.fn(),
  loadEventArtworkAsset: vi.fn(),
  publishEventArtwork: vi.fn(),
  unpublishEventArtwork: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));

describe("catalog event artwork routes", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;
  const context = {
    params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
  };

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let isPublishedVisibleEvent: ReturnType<typeof vi.fn>;
  let requireEventArtworkAccess: ReturnType<typeof vi.fn>;
  let createEventArtworkCandidate: ReturnType<typeof vi.fn>;
  let listEventArtworkCandidates: ReturnType<typeof vi.fn>;
  let loadEventArtworkAsset: ReturnType<typeof vi.fn>;
  let publishEventArtwork: ReturnType<typeof vi.fn>;
  let unpublishEventArtwork: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireCatalogEventsAccess = (await import("@/lib/catalog-events/access")).requireCatalogEventsAccess as ReturnType<
      typeof vi.fn
    >;
    isPublishedVisibleEvent = (await import("@/lib/catalog-events/visibility")).isPublishedVisibleEvent as ReturnType<
      typeof vi.fn
    >;
    requireEventArtworkAccess = (await import("@/lib/event-artwork-access")).requireEventArtworkAccess as ReturnType<
      typeof vi.fn
    >;
    const service = await import("@/lib/event-artwork-service");
    createEventArtworkCandidate = service.createEventArtworkCandidate as ReturnType<typeof vi.fn>;
    listEventArtworkCandidates = service.listEventArtworkCandidates as ReturnType<typeof vi.fn>;
    loadEventArtworkAsset = service.loadEventArtworkAsset as ReturnType<typeof vi.fn>;
    publishEventArtwork = service.publishEventArtwork as ReturnType<typeof vi.fn>;
    unpublishEventArtwork = service.unpublishEventArtwork as ReturnType<typeof vi.fn>;

    requireCatalogEventsAccess.mockResolvedValue({
      catalogGrant: grantFromLevel("OWNER"),
    });
    requireEventArtworkAccess.mockResolvedValue({ userId: "owner-1" });
    isPublishedVisibleEvent.mockResolvedValue(true);
    loadEventArtworkAsset.mockResolvedValue({
      bytes: Buffer.from("artwork"),
      contentType: "image/jpeg",
      artworkId: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
      sha256: "abc123",
    });
    listEventArtworkCandidates.mockResolvedValue([]);
    createEventArtworkCandidate.mockResolvedValue({
      id: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
    });
    publishEventArtwork.mockResolvedValue({
      changed: true,
      previousArtworkId: null,
    });
    unpublishEventArtwork.mockResolvedValue({
      changed: true,
      previousArtworkId: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
    });
  });

  it("serves only the published artwork with a private ETag", async () => {
    const response = await getPublishedArtwork(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artwork?variant=square`),
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(loadEventArtworkAsset).toHaveBeenCalledWith({
      catalogId,
      eventId,
      variant: "square",
      publishedOnly: true,
    });
  });

  it("does not reveal a artwork attached to an unreleased event to listeners", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      catalogGrant: grantFromLevel("LISTENER"),
    });
    isPublishedVisibleEvent.mockResolvedValue(false);

    const response = await getPublishedArtwork(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artwork?variant=landscape`),
      context
    );

    expect(response.status).toBe(404);
    expect(loadEventArtworkAsset).not.toHaveBeenCalled();
  });

  it("requires candidate-view authority before listing drafts", async () => {
    const response = await listArtworkCandidates(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artworks`),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventArtworkAccess).toHaveBeenCalledWith(catalogId, eventId, "view_candidates");
  });

  it("requires both shapes when creating an immutable candidate", async () => {
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artworks`, {
      method: "POST",
      headers: { "content-length": "1024" },
    });
    vi.spyOn(request, "formData").mockResolvedValue({
      get: vi.fn(() => null),
    } as unknown as FormData);

    const response = await createArtworkCandidate(request, context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Both square and landscape artwork files are required",
    });
    expect(requireEventArtworkAccess).toHaveBeenCalledWith(catalogId, eventId, "manage");
    expect(createEventArtworkCandidate).not.toHaveBeenCalled();
  });

  it("passes both uploaded assets to candidate creation", async () => {
    const square = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("square")),
      name: "square.png",
      size: 6,
      type: "image/png",
    };
    const landscape = {
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("landscape")),
      name: "landscape.jpg",
      size: 9,
      type: "image/jpeg",
    };
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artworks`, {
      method: "POST",
      headers: { "content-length": "1024" },
    });
    vi.spyOn(request, "formData").mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name === "square") return square;
        if (name === "landscape") return landscape;
        if (name === "label") return "Version A";
        return null;
      }),
    } as unknown as FormData);

    const response = await createArtworkCandidate(request, context);

    expect(response.status).toBe(201);
    expect(createEventArtworkCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId,
        eventId,
        userId: "owner-1",
        label: "Version A",
        square: expect.objectContaining({ originalName: "square.png" }),
        landscape: expect.objectContaining({ originalName: "landscape.jpg" }),
      })
    );
  });

  it("rejects an upload without a content length before buffering it", async () => {
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artworks`, {
      method: "POST",
    });
    const formData = vi.spyOn(request, "formData");

    const response = await createArtworkCandidate(request, context);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toMatchObject({
      code: "CONTENT_LENGTH_REQUIRED",
    });
    expect(formData).not.toHaveBeenCalled();
    expect(requireEventArtworkAccess).not.toHaveBeenCalled();
  });

  it("rejects a malformed content length before buffering the upload", async () => {
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artworks`, {
      method: "POST",
      headers: { "content-length": "1e3" },
    });
    const formData = vi.spyOn(request, "formData");

    const response = await createArtworkCandidate(request, context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_CONTENT_LENGTH",
    });
    expect(formData).not.toHaveBeenCalled();
  });

  it("publishes a selected candidate through the separate publish capability", async () => {
    const artworkId = "4b58cb81-ad10-4b7f-98ca-f05946711b37";
    const response = await publishArtwork(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artwork-publication`, {
        method: "PUT",
        body: JSON.stringify({ artworkId }),
        headers: { "content-type": "application/json" },
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventArtworkAccess).toHaveBeenCalledWith(catalogId, eventId, "publish");
    expect(publishEventArtwork).toHaveBeenCalledWith({
      catalogId,
      eventId,
      artworkId,
      userId: "owner-1",
    });
  });

  it("supports explicit unpublish", async () => {
    const response = await unpublishArtwork(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/artwork-publication`, {
        method: "DELETE",
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventArtworkAccess).toHaveBeenCalledWith(catalogId, eventId, "publish");
    expect(unpublishEventArtwork).toHaveBeenCalledWith({
      catalogId,
      eventId,
      userId: "owner-1",
    });
  });
});
