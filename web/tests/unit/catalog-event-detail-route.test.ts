import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DELETE as deleteCatalogEvent,
  GET as getCatalogEvent,
} from "@/app/api/catalogs/[id]/events/[eventId]/route";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/event-poster-service", () => ({
  getPublishedEventPoster: vi.fn(),
}));

vi.mock("@/lib/event-poster-storage", () => ({
  finalizeStagedEventPosterAssetsRemoval: vi.fn(),
  restoreStagedEventPosterAssets: vi.fn(),
  stageEventPosterAssetsRemoval: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  getPublishedAccessibleRecordingHashes: vi.fn(),
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
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
  let getPublishedEventPoster: ReturnType<typeof vi.fn>;
  let finalizeStagedEventPosterAssetsRemoval: ReturnType<typeof vi.fn>;
  let restoreStagedEventPosterAssets: ReturnType<typeof vi.fn>;
  let stageEventPosterAssetsRemoval: ReturnType<typeof vi.fn>;
  let getPublishedAccessibleRecordingHashes: ReturnType<typeof vi.fn>;
  let isPublishedVisibleEvent: ReturnType<typeof vi.fn>;
  let prisma: {
    catalogEvent: {
      findFirst: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
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
    getPublishedEventPoster = (await import("@/lib/event-poster-service")).getPublishedEventPoster as ReturnType<
      typeof vi.fn
    >;
    const posterStorage = await import("@/lib/event-poster-storage");
    finalizeStagedEventPosterAssetsRemoval = posterStorage.finalizeStagedEventPosterAssetsRemoval as ReturnType<
      typeof vi.fn
    >;
    restoreStagedEventPosterAssets = posterStorage.restoreStagedEventPosterAssets as ReturnType<typeof vi.fn>;
    stageEventPosterAssetsRemoval = posterStorage.stageEventPosterAssetsRemoval as ReturnType<typeof vi.fn>;
    getPublishedAccessibleRecordingHashes = (await import("@/lib/catalog-events/visibility"))
      .getPublishedAccessibleRecordingHashes as ReturnType<typeof vi.fn>;
    isPublishedVisibleEvent = (await import("@/lib/catalog-events/visibility")).isPublishedVisibleEvent as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
      catalogGrant: grantFromLevel("OWNER"),
    });
    getCatalogCapability.mockResolvedValue({
      canManageAccess: false,
      canViewPosterCandidates: false,
      canManagePosters: false,
      canPublishPosters: false,
    });
    getPublishedEventPoster.mockResolvedValue(null);
    stageEventPosterAssetsRemoval.mockResolvedValue(null);
    restoreStagedEventPosterAssets.mockResolvedValue(undefined);
    finalizeStagedEventPosterAssetsRemoval.mockResolvedValue(undefined);
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

  it("keeps draft event details accessible for owners", async () => {
    const response = await getCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    expect(getCatalogCapability).toHaveBeenCalledWith(catalogId, "owner-1");

    const body = await response.json();
    expect(body.released).toBe(false);
    expect(body.recordings).toHaveLength(0);
    expect(body.canManagePosters).toBe(false);
    expect(body.canViewPosterCandidates).toBe(false);
    expect(body.canPublishPosters).toBe(false);
    expect(body.publishedPoster).toBeNull();
    expect(body.canManageSources).toBe(false);
    expect(isPublishedVisibleEvent).not.toHaveBeenCalled();
    expect(getPublishedAccessibleRecordingHashes).not.toHaveBeenCalled();
  });

  it("returns 404 for listener access when the event is not published-visible", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      accessLevel: "LISTENER",
      catalogGrant: grantFromLevel("LISTENER"),
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
      accessLevel: "LISTENER",
      catalogGrant: grantFromLevel("LISTENER"),
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

  it("stages and removes poster assets when deleting an event", async () => {
    const staged = {
      originalPath: "/posters/events/12",
      stagedPath: "/posters/events/.deleted-12-token",
    };
    stageEventPosterAssetsRemoval.mockResolvedValue(staged);

    const response = await deleteCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(200);
    expect(stageEventPosterAssetsRemoval).toHaveBeenCalledWith(catalogId, eventId);
    expect(prisma.catalogEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: eventId, workflowGroupId: catalogId },
    });
    expect(finalizeStagedEventPosterAssetsRemoval).toHaveBeenCalledWith(staged);
    expect(restoreStagedEventPosterAssets).not.toHaveBeenCalled();
  });

  it("restores staged poster assets when event deletion fails", async () => {
    const staged = {
      originalPath: "/posters/events/12",
      stagedPath: "/posters/events/.deleted-12-token",
    };
    stageEventPosterAssetsRemoval.mockResolvedValue(staged);
    prisma.catalogEvent.deleteMany.mockRejectedValue(new Error("database unavailable"));

    const response = await deleteCatalogEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: catalogId, eventId: String(eventId) }) }
    );

    expect(response.status).toBe(500);
    expect(restoreStagedEventPosterAssets).toHaveBeenCalledWith(staged);
    expect(finalizeStagedEventPosterAssetsRemoval).not.toHaveBeenCalled();
  });
});
