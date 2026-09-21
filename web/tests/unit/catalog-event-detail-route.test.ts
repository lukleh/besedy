import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DELETE as deleteCatalogEvent,
  GET as getCatalogEvent,
} from "@/app/api/catalogs/[id]/events/[eventId]/route";
import { grantForRole } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/event-artwork-service", () => ({
  getPublishedEventArtwork: vi.fn(),
  getEventArtworkWorkflowStatuses: vi.fn(),
  getLatestEventArtworkCandidate: vi.fn(),
}));

vi.mock("@/lib/event-artwork-storage", () => ({
  finalizeStagedEventArtworkAssetsRemoval: vi.fn(),
  restoreStagedEventArtworkAssets: vi.fn(),
  stageEventArtworkAssetsRemoval: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  getPublishedAccessibleRecordingHashes: vi.fn(),
  getPublishedVisibleEventIds: vi.fn(),
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    catalogEntry: {
      findMany: vi.fn(),
    },
    audioMetadata: {
      findMany: vi.fn(),
    },
  },
}));

describe("catalog event detail route", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;
  const primaryHash = "a".repeat(64);

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let getPublishedEventArtwork: ReturnType<typeof vi.fn>;
  let getEventArtworkWorkflowStatuses: ReturnType<typeof vi.fn>;
  let getLatestEventArtworkCandidate: ReturnType<typeof vi.fn>;
  let finalizeStagedEventArtworkAssetsRemoval: ReturnType<typeof vi.fn>;
  let restoreStagedEventArtworkAssets: ReturnType<typeof vi.fn>;
  let stageEventArtworkAssetsRemoval: ReturnType<typeof vi.fn>;
  let getPublishedAccessibleRecordingHashes: ReturnType<typeof vi.fn>;
  let isPublishedVisibleEvent: ReturnType<typeof vi.fn>;
  let prisma: {
    catalogEvent: {
      findFirst: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    audioMetadata: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    requireCatalogEventsAccess = (await import("@/lib/catalog-events/access")).requireCatalogEventsAccess as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (await import("@/lib/access/capabilities")).getCatalogCapability as ReturnType<typeof vi.fn>;
    const artworkService = await import("@/lib/event-artwork-service");
    getPublishedEventArtwork = artworkService.getPublishedEventArtwork as ReturnType<typeof vi.fn>;
    getEventArtworkWorkflowStatuses = artworkService.getEventArtworkWorkflowStatuses as ReturnType<typeof vi.fn>;
    getLatestEventArtworkCandidate = artworkService.getLatestEventArtworkCandidate as ReturnType<typeof vi.fn>;
    const artworkStorage = await import("@/lib/event-artwork-storage");
    finalizeStagedEventArtworkAssetsRemoval = artworkStorage.finalizeStagedEventArtworkAssetsRemoval as ReturnType<
      typeof vi.fn
    >;
    restoreStagedEventArtworkAssets = artworkStorage.restoreStagedEventArtworkAssets as ReturnType<typeof vi.fn>;
    stageEventArtworkAssetsRemoval = artworkStorage.stageEventArtworkAssetsRemoval as ReturnType<typeof vi.fn>;
    getPublishedAccessibleRecordingHashes = (await import("@/lib/catalog-events/visibility"))
      .getPublishedAccessibleRecordingHashes as ReturnType<typeof vi.fn>;
    isPublishedVisibleEvent = (await import("@/lib/catalog-events/visibility")).isPublishedVisibleEvent as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: eventId,
        locationId: 7,
        dateYear: 2024,
        dateMonth: 4,
        dateDay: 3,
        sessionIndex: 1,
      },
    ]);
    (
      (await import("@/lib/catalog-events/visibility"))
        .getPublishedVisibleEventIds as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      catalogGrant: grantForRole("curator"),
    });
    getCatalogCapability.mockResolvedValue({
      canManageAccess: false,
      canViewArtworkCandidates: false,
      canManageArtwork: false,
      canPublishArtwork: false,
    });
    getPublishedEventArtwork.mockResolvedValue(null);
    getEventArtworkWorkflowStatuses.mockResolvedValue(new Map());
    getLatestEventArtworkCandidate.mockResolvedValue(null);
    stageEventArtworkAssetsRemoval.mockResolvedValue(null);
    restoreStagedEventArtworkAssets.mockResolvedValue(undefined);
    finalizeStagedEventArtworkAssetsRemoval.mockResolvedValue(undefined);
    getPublishedAccessibleRecordingHashes.mockResolvedValue(new Set([primaryHash]));
    isPublishedVisibleEvent.mockResolvedValue(true);
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: eventId,
      workflowGroupId: catalogId,
      title: "Launch concert",
      locationId: 7,
      location: { id: 7, name: "Praha" },
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      sessionIndex: 1,
      description: null,
      released: false,
      sortOrder: 1,
      createdById: "user-1",
      updatedById: "user-1",
      createdAt: new Date("2024-04-03T10:00:00.000Z"),
      updatedAt: new Date("2024-04-03T10:00:00.000Z"),
      recordings: [],
    });
    prisma.catalogEntry.findMany.mockResolvedValue([]);
    prisma.audioMetadata.findMany.mockResolvedValue([]);
    prisma.catalogEvent.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("keeps draft event details accessible for curators", async () => {
    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    expect(getCatalogCapability).toHaveBeenCalledWith(catalogId, "owner-1");

    const body = await response.json();
    expect(body.released).toBe(false);
    expect(body.recordings).toHaveLength(0);
    expect(body.sessionOrdinal).toBe(1);
    expect(body.sessionCount).toBe(1);
    expect(body.canManageArtwork).toBe(false);
    expect(body.canViewArtworkCandidates).toBe(false);
    expect(body.canPublishArtwork).toBe(false);
    expect(body.publishedArtwork).toBeNull();
    expect(body.canManageSources).toBe(false);
    expect(isPublishedVisibleEvent).not.toHaveBeenCalled();
    expect(getPublishedAccessibleRecordingHashes).not.toHaveBeenCalled();
    expect(body.artworkStatus).toBeUndefined();
  });

  it("exposes draft artwork status and a labeled preview candidate to actors with draft visibility", async () => {
    getCatalogCapability.mockResolvedValue({
      canManageAccess: false,
      canViewArtworkCandidates: true,
      canManageArtwork: true,
      canPublishArtwork: true,
    });
    getEventArtworkWorkflowStatuses.mockResolvedValue(new Map([[eventId, "draft-only"]]));
    getLatestEventArtworkCandidate.mockResolvedValue({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: "2024-04-01T00:00:00.000Z",
    });

    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.publishedArtwork).toBeNull();
    expect(body.artworkStatus).toBe("draft-only");
    expect(body.latestDraftCandidate).toEqual({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: "2024-04-01T00:00:00.000Z",
    });
    expect(getEventArtworkWorkflowStatuses).toHaveBeenCalledWith(catalogId, [eventId]);
    expect(getLatestEventArtworkCandidate).toHaveBeenCalledWith(catalogId, eventId);
  });

  it("does not expose artwork status or a preview candidate to actors without draft visibility", async () => {
    getEventArtworkWorkflowStatuses.mockResolvedValue(new Map([[eventId, "draft-only"]]));

    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artworkStatus).toBeUndefined();
    expect(body.latestDraftCandidate).toBeNull();
    expect(getLatestEventArtworkCandidate).not.toHaveBeenCalled();
  });

  it("does not fetch a preview candidate when artwork is already published", async () => {
    getCatalogCapability.mockResolvedValue({
      canManageAccess: false,
      canViewArtworkCandidates: true,
      canManageArtworks: true,
      canPublishArtworks: true,
    });
    getEventArtworkWorkflowStatuses.mockResolvedValue(new Map([[eventId, "published"]]));
    getPublishedEventArtwork.mockResolvedValue({
      id: "published-1",
      publishedAt: "2024-04-01T00:00:00.000Z",
      assets: {
        square: { bytes: 100, sha256: "a".repeat(64) },
        landscape: { bytes: 100, sha256: "b".repeat(64) },
      },
    });

    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artworkStatus).toBe("published");
    expect(body.latestDraftCandidate).toBeNull();
    expect(getLatestEventArtworkCandidate).not.toHaveBeenCalled();
  });

  it("returns 404 for listener access when the event is not published-visible", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      catalogGrant: grantForRole("listener"),
    });
    isPublishedVisibleEvent.mockResolvedValue(false);

    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(404);
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
  });

  it("filters unpublished recordings out of the response for listeners", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      catalogGrant: grantForRole("listener"),
    });
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: eventId,
      workflowGroupId: catalogId,
      title: "Launch concert",
      locationId: 7,
      location: { id: 7, name: "Praha" },
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      description: null,
      released: true,
      sortOrder: 1,
      createdById: "user-1",
      updatedById: "user-1",
      createdAt: new Date("2024-04-03T10:00:00.000Z"),
      updatedAt: new Date("2024-04-03T10:00:00.000Z"),
      recordings: [
        {
          audioHash: "a".repeat(64),
          isPrimary: true,
          sortOrder: 0,
          createdAt: new Date("2024-04-03T10:00:00.000Z"),
          updatedAt: new Date("2024-04-03T10:00:00.000Z"),
        },
        {
          audioHash: "b".repeat(64),
          isPrimary: false,
          sortOrder: 1,
          createdAt: new Date("2024-04-03T10:00:00.000Z"),
          updatedAt: new Date("2024-04-03T10:00:00.000Z"),
        },
      ],
    });
    getPublishedAccessibleRecordingHashes.mockResolvedValue(new Set([primaryHash]));
    prisma.catalogEntry.findMany.mockResolvedValue([
      {
        audioHash: primaryHash,
        durationHms: "00:10:00",
        sourceTitle: "Primary recording",
        sourceArtist: null,
      },
    ]);

    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recordings).toHaveLength(1);
    expect(body.recordings[0].audioHash).toBe(primaryHash);
  });

  it("stages and removes artwork assets when deleting an event", async () => {
    const staged = {
      originalPath: "/artworks/events/12",
      stagedPath: "/artworks/events/.deleted-12-token",
    };
    stageEventArtworkAssetsRemoval.mockResolvedValue(staged);

    const response = await deleteCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    expect(stageEventArtworkAssetsRemoval).toHaveBeenCalledWith(catalogId, eventId);
    expect(prisma.catalogEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: eventId, workflowGroupId: catalogId },
    });
    expect(finalizeStagedEventArtworkAssetsRemoval).toHaveBeenCalledWith(staged);
    expect(restoreStagedEventArtworkAssets).not.toHaveBeenCalled();
  });

  it("restores staged artwork assets when event deletion fails", async () => {
    const staged = {
      originalPath: "/artworks/events/12",
      stagedPath: "/artworks/events/.deleted-12-token",
    };
    stageEventArtworkAssetsRemoval.mockResolvedValue(staged);
    prisma.catalogEvent.deleteMany.mockRejectedValue(new Error("database unavailable"));

    const response = await deleteCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(500);
    expect(restoreStagedEventArtworkAssets).toHaveBeenCalledWith(staged);
    expect(finalizeStagedEventArtworkAssetsRemoval).not.toHaveBeenCalled();
  });
});
