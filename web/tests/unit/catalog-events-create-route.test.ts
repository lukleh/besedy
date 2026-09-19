import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as createCatalogEvent } from "@/app/api/catalog-events/route";

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
    location: {
      findFirst: vi.fn(),
    },
    catalogEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe("catalog events create route", () => {
  const catalogId = "20260201_120000";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    location: { findFirst: ReturnType<typeof vi.fn> };
    catalogEvent: {
      findFirst: ReturnType<typeof vi.fn>;
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
      accessLevel: "OWNER",
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: catalogId });
    prisma.location.findFirst.mockResolvedValue({ id: 7, name: "Praha" });
  });

  it("creates the first session at a free location and date", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue(null);
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
    prisma.catalogEvent.findFirst.mockResolvedValue({ id: 88, sessionIndex: 1 });

    const response = await createCatalogEvent(buildRequest({}));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/Event 88 already covers/i);
    expect(body.error).toMatch(/sessionIndex 2/);
    expect(prisma.catalogEvent.create).not.toHaveBeenCalled();
  });

  it("names the next free session when several already exist", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue({ id: 90, sessionIndex: 3 });

    const response = await createCatalogEvent(buildRequest({}));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/sessionIndex 4/);
  });

  it("creates the extra session when the caller asks for one explicitly", async () => {
    prisma.catalogEvent.create.mockResolvedValue({
      id: 89,
      title: "Praha, 3 Apr 2024, session 2",
      _count: { recordings: 0 },
    });

    const response = await createCatalogEvent(buildRequest({ sessionIndex: 2 }));

    expect(response.status).toBe(201);
    // An explicit sessionIndex is deliberate, so the guard lookup is skipped
    // and the unique identity index remains the only arbiter.
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
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
    prisma.catalogEvent.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const response = await createCatalogEvent(buildRequest({ sessionIndex: 2 }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/location, date, and session already exists/i);
  });

  it("treats a partial date as its own identity slot", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue(null);
    prisma.catalogEvent.create.mockResolvedValue({
      id: 91,
      title: "Praha, 2024",
      _count: { recordings: 0 },
    });

    const response = await createCatalogEvent(
      buildRequest({ dateMonth: null, dateDay: null })
    );

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.findFirst).toHaveBeenCalledWith(
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
