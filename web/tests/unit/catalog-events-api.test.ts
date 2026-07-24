import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH as patchEvent } from "@/app/api/catalogs/[id]/events/[eventId]/route";
import { POST as attachRecordings } from "@/app/api/catalogs/[id]/events/[eventId]/recordings/route";
import { DELETE as detachRecording } from "@/app/api/catalogs/[id]/events/[eventId]/recordings/[audioHash]/route";
import { POST as setPrimaryRecording } from "@/app/api/catalogs/[id]/events/[eventId]/recordings/[audioHash]/set-primary/route";

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/notifications/event-notifications", () => ({
  createEventNotifications: vi.fn(),
}));

vi.mock("@/lib/notifications/push", () => ({
  sendEventPushNotifications: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    catalogEvent: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    catalogEventRecording: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    catalogEntry: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowGroup: {
      update: vi.fn(),
    },
    location: {
      findUnique: vi.fn(),
    },
  },
}));

describe("catalog events API", () => {
  const catalogId = "20260201_120000";
  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let createEventNotifications: ReturnType<typeof vi.fn>;
  let sendEventPushNotifications: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    catalogEvent: {
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    catalogEventRecording: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    catalogEntry: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    workflowGroup: {
      update: ReturnType<typeof vi.fn>;
    };
    location: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const accessModule = await import("@/lib/catalog-events/access");
    requireCatalogEventsAccess = accessModule.requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    const eventNotificationsModule = await import("@/lib/notifications/event-notifications");
    createEventNotifications =
      eventNotificationsModule.createEventNotifications as ReturnType<typeof vi.fn>;
    const pushModule = await import("@/lib/notifications/push");
    sendEventPushNotifications =
      pushModule.sendEventPushNotifications as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "admin-user",
      accessLevel: "OWNER",
    });
    createEventNotifications.mockResolvedValue({
      created: 0,
      recipientUserIds: [],
    });
    sendEventPushNotifications.mockResolvedValue({ sent: 0, failed: 0 });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 1 }]);
  });

  it("blocks releasing an event without exactly one primary recording", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 12,
      workflowGroupId: "20260201_120000",
      locationId: 3,
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      location: { id: 3, name: "Praha" },
    });
    prisma.catalogEventRecording.count.mockResolvedValue(0);

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/12`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released: true }),
    });
    const response = await patchEvent(request, {
      params: Promise.resolve({ id: catalogId, eventId: "12" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/cannot be released/i);
    expect(prisma.catalogEvent.update).not.toHaveBeenCalled();
  });

  it("blocks detaching the primary recording from a released event", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 42,
      workflowGroupId: "20260201_120000",
      released: true,
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue({
      eventId: 42,
      isPrimary: true,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/42/recordings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      { method: "DELETE" }
    );
    const response = await detachRecording(request, {
      params: Promise.resolve({
        id: catalogId,
        eventId: "42",
        audioHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/cannot detach/i);
    expect(prisma.catalogEventRecording.delete).not.toHaveBeenCalled();
  });

  it("attaches valid hashes and reports missing hashes", async () => {
    const attachedHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 9,
      workflowGroupId: "20260201_120000",
      released: false,
    });
    prisma.catalogEntry.findMany.mockResolvedValue([
      { audioHash: attachedHash, isActionable: true },
    ]);
    prisma.catalogEventRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          audioHash: attachedHash,
          eventId: 9,
        },
      ]);
    prisma.catalogEventRecording.createMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/9/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioHashes: [
          attachedHash,
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
      }),
    });
    const response = await attachRecordings(request, {
      params: Promise.resolve({ id: catalogId, eventId: "9" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attachedCount).toBe(1);
    expect(body.attachedAudioHashes).toEqual([attachedHash]);
    expect(body.errors).toEqual([
      {
        audioHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        reason: "missing_in_catalog",
      },
    ]);
    expect(prisma.catalogEventRecording.updateMany).not.toHaveBeenCalled();
    expect(prisma.catalogEvent.updateMany).not.toHaveBeenCalled();
    expect(prisma.catalogEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("returns 400 when none of the hashes are attachable", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 11,
      workflowGroupId: "20260201_120000",
      released: false,
    });
    prisma.catalogEntry.findMany.mockResolvedValue([
      { audioHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", isActionable: false },
    ]);
    prisma.catalogEventRecording.findMany.mockResolvedValue([]);

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/11/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioHashes: ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
      }),
    });
    const response = await attachRecordings(request, {
      params: Promise.resolve({ id: catalogId, eventId: "11" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/No recordings could be attached/);
    expect(body.details?.errors).toEqual([
      {
        audioHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        reason: "non_actionable",
      },
    ]);
  });

  it("returns conflict error when post-write assignment races to another event", async () => {
    const racedHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 15,
      workflowGroupId: "20260201_120000",
      released: true,
    });
    prisma.catalogEntry.findMany.mockResolvedValue([
      { audioHash: racedHash, isActionable: true },
    ]);
    prisma.catalogEventRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ audioHash: racedHash, eventId: 77 }]);
    prisma.catalogEventRecording.createMany.mockResolvedValue({ count: 0 });

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/15/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioHashes: [racedHash],
      }),
    });
    const response = await attachRecordings(request, {
      params: Promise.resolve({ id: catalogId, eventId: "15" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/No recordings could be attached/);
    expect(body.details?.errors).toEqual([
      { audioHash: racedHash, reason: "assigned_to_other_event" },
    ]);
    expect(prisma.catalogEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowGroup.update).not.toHaveBeenCalled();
  });

  it("publishes recordings attached to a released event", async () => {
    const attachedHash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 19,
      workflowGroupId: "20260201_120000",
      released: true,
    });
    prisma.catalogEntry.findMany.mockResolvedValue([
      { audioHash: attachedHash, isActionable: true },
    ]);
    prisma.catalogEventRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ audioHash: attachedHash, eventId: 19 }]);
    prisma.catalogEventRecording.createMany.mockResolvedValue({ count: 1 });
    prisma.catalogEntry.updateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/19/recordings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioHashes: [attachedHash],
        }),
      }
    );
    const response = await attachRecordings(request, {
      params: Promise.resolve({ id: catalogId, eventId: "19" }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogEntry.updateMany).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: [attachedHash] },
        isActionable: true,
        isPublished: false,
      },
      data: {
        isPublished: true,
      },
    });
    expect(prisma.workflowGroup.update).toHaveBeenCalledWith({
      where: { id: catalogId },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("publishes all attached recordings when an event is released", async () => {
    const primaryHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const secondaryHash = "9999999999999999999999999999999999999999999999999999999999999999";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 12,
      workflowGroupId: "20260201_120000",
      locationId: 3,
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      location: { id: 3, name: "Praha" },
    });
    prisma.catalogEventRecording.count.mockResolvedValue(1);
    prisma.catalogEvent.update.mockResolvedValue({
      id: 12,
      workflowGroupId: catalogId,
      title: "Praha, 3 Apr 2024",
      locationId: 3,
      location: { id: 3, name: "Praha" },
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      description: null,
      released: true,
      sortOrder: 0,
      createdAt: new Date("2024-04-03T10:00:00.000Z"),
      updatedAt: new Date("2024-04-03T10:00:00.000Z"),
      _count: { recordings: 2 },
    });
    prisma.catalogEvent.findUnique.mockResolvedValue({ released: true });
    prisma.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: primaryHash },
      { audioHash: secondaryHash },
    ]);
    prisma.catalogEntry.updateMany.mockResolvedValue({ count: 2 });
    createEventNotifications.mockResolvedValue({
      created: 2,
      recipientUserIds: ["user-1", "user-2"],
    });

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/12`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released: true }),
    });
    const response = await patchEvent(request, {
      params: Promise.resolve({ id: catalogId, eventId: "12" }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogEntry.updateMany).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: [primaryHash, secondaryHash] },
        isActionable: true,
        isPublished: false,
      },
      data: {
        isPublished: true,
      },
    });
    expect(prisma.workflowGroup.update).toHaveBeenCalledWith({
      where: { id: catalogId },
      data: { updatedAt: expect.any(Date) },
    });
    expect(createEventNotifications).toHaveBeenCalledWith(prisma, {
      catalogId,
      eventId: 12,
      title: "Praha, 3 Apr 2024",
    });
    expect(sendEventPushNotifications).toHaveBeenCalledWith({
      catalogId,
      eventId: 12,
      eventTitle: "Praha, 3 Apr 2024",
      recipientUserIds: ["user-1", "user-2"],
    });
  });

  it("does not notify again when a previously published event is re-released", async () => {
    const primaryHash = "1212121212121212121212121212121212121212121212121212121212121212";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 12,
      workflowGroupId: "20260201_120000",
      locationId: 3,
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      released: false,
      publishedNotifiedAt: new Date("2024-04-03T10:00:00.000Z"),
      location: { id: 3, name: "Praha" },
    });
    prisma.catalogEventRecording.count.mockResolvedValue(1);
    prisma.catalogEvent.update.mockResolvedValue({
      id: 12,
      workflowGroupId: catalogId,
      title: "Praha, 3 Apr 2024",
      locationId: 3,
      location: { id: 3, name: "Praha" },
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      description: null,
      released: true,
      sortOrder: 0,
      createdAt: new Date("2024-04-03T10:00:00.000Z"),
      updatedAt: new Date("2024-04-04T10:00:00.000Z"),
      _count: { recordings: 1 },
    });
    prisma.catalogEvent.findUnique.mockResolvedValue({ released: true });
    prisma.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: primaryHash },
    ]);
    prisma.catalogEntry.updateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/12`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released: true }),
    });
    const response = await patchEvent(request, {
      params: Promise.resolve({ id: catalogId, eventId: "12" }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogEntry.updateMany).toHaveBeenCalledWith({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: [primaryHash] },
        isActionable: true,
        isPublished: false,
      },
      data: {
        isPublished: true,
      },
    });
    expect(createEventNotifications).not.toHaveBeenCalled();
    expect(sendEventPushNotifications).not.toHaveBeenCalled();
  });

  it("does not unpublish recordings when an event is unreleased", async () => {
    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 12,
      workflowGroupId: "20260201_120000",
      locationId: 3,
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      location: { id: 3, name: "Praha" },
    });
    prisma.catalogEvent.update.mockResolvedValue({
      id: 12,
      workflowGroupId: catalogId,
      title: "Praha, 3 Apr 2024",
      locationId: 3,
      location: { id: 3, name: "Praha" },
      dateYear: 2024,
      dateMonth: 4,
      dateDay: 3,
      description: null,
      released: false,
      sortOrder: 0,
      createdAt: new Date("2024-04-03T10:00:00.000Z"),
      updatedAt: new Date("2024-04-03T10:00:00.000Z"),
      _count: { recordings: 2 },
    });

    const request = new NextRequest(`http://localhost/api/catalogs/${catalogId}/events/12`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ released: false }),
    });
    const response = await patchEvent(request, {
      params: Promise.resolve({ id: catalogId, eventId: "12" }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowGroup.update).not.toHaveBeenCalled();
    expect(createEventNotifications).not.toHaveBeenCalled();
    expect(sendEventPushNotifications).not.toHaveBeenCalled();
  });

  it("detaches the recording without auto-normalizing singleton event state", async () => {
    const removedHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 42,
      workflowGroupId: "20260201_120000",
      released: false,
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue({
      eventId: 42,
      isPrimary: true,
    });
    prisma.catalogEventRecording.delete.mockResolvedValue({
      workflowGroupId: catalogId,
      audioHash: removedHash,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/42/recordings/${removedHash}`,
      { method: "DELETE" }
    );
    const response = await detachRecording(request, {
      params: Promise.resolve({
        id: catalogId,
        eventId: "42",
        audioHash: removedHash,
      }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogEventRecording.updateMany).not.toHaveBeenCalled();
    expect(prisma.catalogEvent.updateMany).not.toHaveBeenCalled();
  });

  it("locks the event row before swapping the primary recording", async () => {
    const primaryHash = "abababababababababababababababababababababababababababababababab";

    prisma.catalogEvent.findFirst.mockResolvedValue({
      id: 24,
      workflowGroupId: catalogId,
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue({
      eventId: 24,
    });
    prisma.catalogEventRecording.updateMany.mockResolvedValue({ count: 1 });
    prisma.catalogEventRecording.update.mockResolvedValue({
      workflowGroupId: catalogId,
      audioHash: primaryHash,
      isPrimary: true,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${catalogId}/events/24/recordings/${primaryHash}/set-primary`,
      { method: "POST" }
    );
    const response = await setPrimaryRecording(request, {
      params: Promise.resolve({
        id: catalogId,
        eventId: "24",
        audioHash: primaryHash,
      }),
    });

    expect(response.status).toBe(200);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.catalogEvent.findFirst).toHaveBeenCalledWith({
      where: { id: 24, workflowGroupId: catalogId },
      select: { id: true, workflowGroupId: true },
    });
    expect(prisma.catalogEventRecording.updateMany).toHaveBeenCalledWith({
      where: {
        eventId: 24,
        workflowGroupId: catalogId,
        isPrimary: true,
      },
      data: { isPrimary: false },
    });
    expect(prisma.catalogEventRecording.update).toHaveBeenCalledWith({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: primaryHash,
        },
      },
      data: { isPrimary: true },
    });
  });
});
