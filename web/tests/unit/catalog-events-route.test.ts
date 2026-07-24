import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogEvents } from "@/app/api/catalog-events/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  getPublishedVisibleEventIds: vi.fn(),
}));

vi.mock("@/lib/event-posters", () => ({
  getPosterStatus: vi.fn(),
}));

vi.mock("@/lib/event-sources", () => ({
  readEventSources: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findFirst: vi.fn(),
    },
    catalogEvent: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    location: {
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

describe("catalog events route", () => {
  const catalogId = "20260201_120000";
  const primaryHash = "a".repeat(64);

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let getPublishedVisibleEventIds: ReturnType<typeof vi.fn>;
  let getPosterStatus: ReturnType<typeof vi.fn>;
  let readEventSources: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    catalogEvent: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    location: { findMany: ReturnType<typeof vi.fn> };
    catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    audioMetadata: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    requireCatalogEventsAccess = (await import("@/lib/catalog-events/access"))
      .requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    getPublishedVisibleEventIds = (
      await import("@/lib/catalog-events/visibility")
    ).getPublishedVisibleEventIds as ReturnType<typeof vi.fn>;
    getPosterStatus = (await import("@/lib/event-posters"))
      .getPosterStatus as ReturnType<typeof vi.fn>;
    readEventSources = (await import("@/lib/event-sources"))
      .readEventSources as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([7]);
    getPosterStatus.mockResolvedValue({ portrait: false, landscape: false });
    readEventSources.mockResolvedValue([]);

    prisma.workflowGroup.findFirst.mockResolvedValue({ id: catalogId });
    prisma.catalogEvent.count.mockResolvedValue(1);
    prisma.catalogEvent.findMany
      .mockResolvedValueOnce([
        {
          id: 7,
          workflowGroupId: catalogId,
          title: "Visible event",
          locationId: 3,
          location: { id: 3, name: "Praha" },
          dateYear: 2024,
          dateMonth: 4,
          dateDay: 3,
          description: null,
          released: false,
          sortOrder: 1,
          createdAt: new Date("2024-04-03T10:00:00.000Z"),
          updatedAt: new Date("2024-04-03T10:00:00.000Z"),
          recordings: [{ audioHash: primaryHash }],
          _count: { recordings: 1 },
        },
      ])
      .mockResolvedValueOnce([{ dateYear: 2024 }]);
    prisma.location.findMany.mockResolvedValue([{ id: 3, name: "Praha" }]);
    prisma.catalogEntry.findMany.mockResolvedValue([
      {
        audioHash: primaryHash,
        sourceTitle: "Primary recording",
      },
    ]);
    prisma.audioMetadata.findMany.mockResolvedValue([]);
  });

  it("keeps draft events visible for owner listings", async () => {
    const response = await getCatalogEvents(
      new NextRequest(`http://localhost/api/catalog-events?group=${catalogId}`),
    );

    expect(response.status).toBe(200);
    expect(getPublishedVisibleEventIds).not.toHaveBeenCalled();
    expect(prisma.catalogEvent.count).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
      },
    });
    expect(prisma.catalogEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          workflowGroupId: catalogId,
        },
      }),
    );

    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe(7);
    expect(body.events[0].released).toBe(false);
  });

  it("limits listener listings to published-visible event ids", async () => {
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      accessLevel: "LISTENER",
    });

    const response = await getCatalogEvents(
      new NextRequest(`http://localhost/api/catalog-events?group=${catalogId}`),
    );

    expect(response.status).toBe(200);
    expect(getPublishedVisibleEventIds).toHaveBeenCalledWith(prisma, catalogId);
    expect(prisma.catalogEvent.count).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        id: { in: [7] },
      },
    });
  });

  it("applies the text search filter to event title and location name", async () => {
    const response = await getCatalogEvents(
      new NextRequest(
        `http://localhost/api/catalog-events?group=${catalogId}&search=%20Praha%20`,
      ),
    );

    expect(response.status).toBe(200);
    expect(prisma.catalogEvent.count).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        OR: [
          { title: { contains: "Praha", mode: "insensitive" } },
          { location: { name: { contains: "Praha", mode: "insensitive" } } },
        ],
      },
    });
    expect(prisma.catalogEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          workflowGroupId: catalogId,
          OR: [
            { title: { contains: "Praha", mode: "insensitive" } },
            { location: { name: { contains: "Praha", mode: "insensitive" } } },
          ],
        },
      }),
    );
  });
});
