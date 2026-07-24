import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as createFromRecording } from "@/app/api/catalog-events/from-recording/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    catalogEntry: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    audioMetadata: {
      findFirst: vi.fn(),
    },
    catalogEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    catalogEventRecording: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe("catalog events create-from-recording route", () => {
  const catalogId = "20260201_120000";
  const audioHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    catalogEntry: {
      findFirst: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    audioMetadata: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    catalogEvent: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    catalogEventRecording: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireCatalogEventsAccess = (
      await import("@/lib/catalog-events/access")
    ).requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "admin-user",
      accessLevel: "OWNER",
    });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
    );
  });

  it("creates an unreleased single-recording event from an unassigned recording", async () => {
    prisma.catalogEntry.findFirst.mockResolvedValue({
      audioHash,
      isActionable: true,
    });
    prisma.audioMetadata.findFirst.mockResolvedValue({
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      location: {
        id: 7,
        name: "Praha",
      },
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue(null);
    prisma.catalogEvent.findFirst.mockResolvedValue(null);
    prisma.catalogEvent.create.mockResolvedValue({
      id: 88,
      title: "Praha, 3 Apr 2024",
    });
    prisma.catalogEventRecording.create.mockResolvedValue({
      eventId: 88,
      workflowGroupId: catalogId,
      audioHash,
      isPrimary: true,
    });

    const request = new NextRequest("http://localhost/api/catalog-events/from-recording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowGroupId: catalogId,
        audioHash,
      }),
    });
    const response = await createFromRecording(request);

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.create).toHaveBeenCalledWith({
      data: {
        workflowGroupId: catalogId,
        title: "Praha, 3 Apr 2024",
        locationId: 7,
        dateYear: 2024,
        dateMonth: 4,
        dateDay: 3,
        sessionIndex: 1,
        released: false,
        createdById: "admin-user",
        updatedById: "admin-user",
      },
      select: {
        id: true,
        title: true,
      },
    });
    expect(prisma.catalogEventRecording.create).toHaveBeenCalledWith({
      data: {
        eventId: 88,
        workflowGroupId: catalogId,
        audioHash,
        isPrimary: true,
      },
    });
    expect(prisma.catalogEntry.updateMany).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual({
      eventId: 88,
      audioHash,
      title: "Praha, 3 Apr 2024",
      sessionIndex: 1,
    });
  });

  it("creates the next session when a same-place same-day event already exists", async () => {
    prisma.catalogEntry.findFirst.mockResolvedValue({
      audioHash,
      isActionable: true,
    });
    prisma.audioMetadata.findFirst.mockResolvedValue({
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      location: {
        id: 7,
        name: "Praha",
      },
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue(null);
    prisma.catalogEvent.findFirst.mockResolvedValue({ sessionIndex: 1 });
    prisma.catalogEvent.create.mockResolvedValue({
      id: 89,
      title: "Praha, 3 Apr 2024, session 2",
    });
    prisma.catalogEventRecording.create.mockResolvedValue({
      eventId: 89,
      workflowGroupId: catalogId,
      audioHash,
      isPrimary: true,
    });

    const request = new NextRequest("http://localhost/api/catalog-events/from-recording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowGroupId: catalogId,
        audioHash,
      }),
    });
    const response = await createFromRecording(request);

    expect(response.status).toBe(201);
    expect(prisma.catalogEvent.findFirst).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        locationId: 7,
        dateYear: 2024,
        dateMonth: 4,
        dateDay: 3,
      },
      select: { sessionIndex: true },
      orderBy: { sessionIndex: "desc" },
    });
    expect(prisma.catalogEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionIndex: 2,
        title: "Praha, 3 Apr 2024, session 2",
      }),
      select: {
        id: true,
        title: true,
      },
    });

    const body = await response.json();
    expect(body).toEqual({
      eventId: 89,
      audioHash,
      title: "Praha, 3 Apr 2024, session 2",
      sessionIndex: 2,
    });
  });

  it("returns 400 when the recording lacks required event metadata", async () => {
    prisma.catalogEntry.findFirst.mockResolvedValue({
      audioHash,
      isActionable: true,
    });
    prisma.audioMetadata.findFirst.mockResolvedValue({
      dateYear: null,
      dateMonth: null,
      dateDay: null,
      location: null,
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/catalog-events/from-recording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowGroupId: catalogId,
        audioHash,
      }),
    });
    const response = await createFromRecording(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/location and year metadata/i);
    expect(prisma.catalogEvent.create).not.toHaveBeenCalled();
    expect(prisma.catalogEventRecording.create).not.toHaveBeenCalled();
    expect(prisma.catalogEntry.updateMany).not.toHaveBeenCalled();
  });
});
