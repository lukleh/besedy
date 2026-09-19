import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getPublishedPoster } from "@/app/api/catalogs/[id]/events/[eventId]/poster/route";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";
import {
  GET as listPosterCandidates,
  POST as createPosterCandidate,
} from "@/app/api/catalogs/[id]/events/[eventId]/posters/route";
import {
  DELETE as unpublishPoster,
  PUT as publishPoster,
} from "@/app/api/catalogs/[id]/events/[eventId]/poster-publication/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock("@/lib/event-poster-access", () => ({
  requireEventPosterAccess: vi.fn(),
}));

vi.mock("@/lib/event-poster-service", () => ({
  EventPosterServiceError: class EventPosterServiceError extends Error {
    constructor(
      message: string,
      public statusCode: number
    ) {
      super(message);
    }
  },
  createEventPosterCandidate: vi.fn(),
  listEventPosterCandidates: vi.fn(),
  loadEventPosterAsset: vi.fn(),
  publishEventPoster: vi.fn(),
  unpublishEventPoster: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));

describe("catalog event poster routes", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;
  const context = {
    params: Promise.resolve({ id: catalogId, eventId: String(eventId) }),
  };

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let isPublishedVisibleEvent: ReturnType<typeof vi.fn>;
  let requireEventPosterAccess: ReturnType<typeof vi.fn>;
  let createEventPosterCandidate: ReturnType<typeof vi.fn>;
  let listEventPosterCandidates: ReturnType<typeof vi.fn>;
  let loadEventPosterAsset: ReturnType<typeof vi.fn>;
  let publishEventPoster: ReturnType<typeof vi.fn>;
  let unpublishEventPoster: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireCatalogEventsAccess = (await import("@/lib/catalog-events/access")).requireCatalogEventsAccess as ReturnType<
      typeof vi.fn
    >;
    isPublishedVisibleEvent = (await import("@/lib/catalog-events/visibility")).isPublishedVisibleEvent as ReturnType<
      typeof vi.fn
    >;
    requireEventPosterAccess = (await import("@/lib/event-poster-access")).requireEventPosterAccess as ReturnType<
      typeof vi.fn
    >;
    const service = await import("@/lib/event-poster-service");
    createEventPosterCandidate = service.createEventPosterCandidate as ReturnType<typeof vi.fn>;
    listEventPosterCandidates = service.listEventPosterCandidates as ReturnType<typeof vi.fn>;
    loadEventPosterAsset = service.loadEventPosterAsset as ReturnType<typeof vi.fn>;
    publishEventPoster = service.publishEventPoster as ReturnType<typeof vi.fn>;
    unpublishEventPoster = service.unpublishEventPoster as ReturnType<typeof vi.fn>;

    requireCatalogEventsAccess.mockResolvedValue({
      catalogGrant: grantFromLevel("OWNER"),
    });
    requireEventPosterAccess.mockResolvedValue({ userId: "owner-1" });
    isPublishedVisibleEvent.mockResolvedValue(true);
    loadEventPosterAsset.mockResolvedValue({
      bytes: Buffer.from("poster"),
      contentType: "image/jpeg",
      posterId: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
      sha256: "abc123",
    });
    listEventPosterCandidates.mockResolvedValue([]);
    createEventPosterCandidate.mockResolvedValue({
      id: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
    });
    publishEventPoster.mockResolvedValue({
      changed: true,
      previousPosterId: null,
    });
    unpublishEventPoster.mockResolvedValue({
      changed: true,
      previousPosterId: "4b58cb81-ad10-4b7f-98ca-f05946711b37",
    });
  });

  it("serves only the published poster with a private ETag", async () => {
    const response = await getPublishedPoster(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster?variant=square`),
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(loadEventPosterAsset).toHaveBeenCalledWith({
      catalogId,
      eventId,
      variant: "square",
      publishedOnly: true,
    });
  });

  it("does not reveal a poster attached to an unreleased event to listeners", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      catalogGrant: grantFromLevel("LISTENER"),
    });
    isPublishedVisibleEvent.mockResolvedValue(false);

    const response = await getPublishedPoster(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster?variant=landscape`),
      context
    );

    expect(response.status).toBe(404);
    expect(loadEventPosterAsset).not.toHaveBeenCalled();
  });

  it("requires candidate-view authority before listing drafts", async () => {
    const response = await listPosterCandidates(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/posters`),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventPosterAccess).toHaveBeenCalledWith(catalogId, eventId, "view_candidates");
  });

  it("requires both shapes when creating an immutable candidate", async () => {
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/posters`, {
      method: "POST",
    });
    vi.spyOn(request, "formData").mockResolvedValue({
      get: vi.fn(() => null),
    } as unknown as FormData);

    const response = await createPosterCandidate(request, context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Both square and landscape poster files are required",
    });
    expect(requireEventPosterAccess).toHaveBeenCalledWith(catalogId, eventId, "manage");
    expect(createEventPosterCandidate).not.toHaveBeenCalled();
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
    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/posters`, {
      method: "POST",
    });
    vi.spyOn(request, "formData").mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name === "square") return square;
        if (name === "landscape") return landscape;
        if (name === "label") return "Version A";
        return null;
      }),
    } as unknown as FormData);

    const response = await createPosterCandidate(request, context);

    expect(response.status).toBe(201);
    expect(createEventPosterCandidate).toHaveBeenCalledWith(
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

  it("publishes a selected candidate through the separate publish capability", async () => {
    const posterId = "4b58cb81-ad10-4b7f-98ca-f05946711b37";
    const response = await publishPoster(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster-publication`, {
        method: "PUT",
        body: JSON.stringify({ posterId }),
        headers: { "content-type": "application/json" },
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventPosterAccess).toHaveBeenCalledWith(catalogId, eventId, "publish");
    expect(publishEventPoster).toHaveBeenCalledWith({
      catalogId,
      eventId,
      posterId,
      userId: "owner-1",
    });
  });

  it("supports explicit unpublish", async () => {
    const response = await unpublishPoster(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}/poster-publication`, {
        method: "DELETE",
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(requireEventPosterAccess).toHaveBeenCalledWith(catalogId, eventId, "publish");
    expect(unpublishEventPoster).toHaveBeenCalledWith({
      catalogId,
      eventId,
      userId: "owner-1",
    });
  });
});
