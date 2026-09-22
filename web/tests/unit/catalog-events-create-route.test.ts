import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as createCatalogEvent } from "@/app/api/catalog-events/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  getPublishedVisibleEventIds: vi.fn(),
}));

vi.mock("@/lib/event-sources", () => ({
  readEventSources: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    workflowGroup: {
      findFirst: vi.fn(),
    },
    location: {
      findFirst: vi.fn(),
    },
    catalogEntry: {
      findMany: vi.fn(),
    },
    audioMetadata: {
      findMany: vi.fn(),
    },
    catalogEvent: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe("catalog events create route", () => {
  const catalogId = "20260201_120000";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    location: { findFirst: ReturnType<typeof vi.fn> };
    catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    audioMetadata: { findMany: ReturnType<typeof vi.fn> };
    catalogEvent: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };

  function buildRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/catalog-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowGroupId: catalogId,
        locationId: 7,
        dateYear: 2024,
        dateMonth: 4,
        dateDay: 3,
        ...body,
      }),
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    requireCatalogEventsAccess = (await import("@/lib/catalog-events/access"))
      .requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "admin-user",
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: catalogId });
    prisma.location.findFirst.mockResolvedValue({ id: 7, name: "Praha" });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
    );
  });

  it("creates the first session at a free location and date", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([]);
    prisma.catalogEvent.create.mockResolvedValue({
      id: 88,
      title: "Praha, 3 Apr 2024",
      _count: { recordings: 0 },
    });

    const response = await createCatalogEvent(buildRequest({}));

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionIndex: 1,
          title: "Praha, 3 Apr 2024",
        }),
      })
    );
  });

  it("returns 409 instead of silently adding a second session", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: 88,
        title: "Existing discussion",
        sessionIndex: 1,
        recordings: [],
        _count: { recordings: 0 },
      },
    ]);

    const response = await createCatalogEvent(buildRequest({}));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/events already cover/i);
    expect(body.details).toEqual({
      reason: "EVENT_CREATION_REQUIRES_DECISION",
      candidates: [
        {
          id: 88,
          title: "Existing discussion",
          sessionIndex: 1,
          recordingCount: 0,
          primaryTitle: null,
        },
      ],
    });
    expect(prisma.catalogEvent.create).not.toHaveBeenCalled();
  });

  it("returns every matching event so the caller can choose", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: 88,
        title: "Morning discussion",
        sessionIndex: 1,
        recordings: [],
        _count: { recordings: 1 },
      },
      {
        id: 90,
        title: "Afternoon discussion",
        sessionIndex: 3,
        recordings: [],
        _count: { recordings: 2 },
      },
    ]);

    const response = await createCatalogEvent(buildRequest({}));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.details.candidates).toHaveLength(2);
    expect(body.details.candidates.map((candidate: { id: number }) => candidate.id)).toEqual([
      88,
      90,
    ]);
  });

  it("creates the extra session when the caller asks for one explicitly", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: 88,
        title: "Existing discussion",
        sessionIndex: 1,
        recordings: [],
        _count: { recordings: 0 },
      },
    ]);
    prisma.catalogEvent.create.mockResolvedValue({
      id: 89,
      title: "Praha, 3 Apr 2024, session 2",
      _count: { recordings: 0 },
    });

    const response = await createCatalogEvent(
      buildRequest({ intent: "create_distinct" })
    );

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.findMany).toHaveBeenCalled();
    expect(prisma.catalogEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionIndex: 2,
          title: "Praha, 3 Apr 2024, session 2",
        }),
      })
    );
  });

  it("still reports the identity conflict when an explicit session is taken", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: 88,
        title: "Existing discussion",
        sessionIndex: 1,
        recordings: [],
        _count: { recordings: 0 },
      },
    ]);
    prisma.catalogEvent.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const response = await createCatalogEvent(
      buildRequest({ intent: "create_distinct" })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/location, date, and session already exists/i);
  });

  it("treats a partial date as its own identity slot", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([]);
    prisma.catalogEvent.create.mockResolvedValue({
      id: 91,
      title: "Praha, 2024",
      _count: { recordings: 0 },
    });

    const response = await createCatalogEvent(
      buildRequest({ dateMonth: null, dateDay: null })
    );

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: catalogId,
          locationId: 7,
          dateYear: 2024,
          dateMonth: null,
          dateDay: null,
        },
      })
    );
  });
});
