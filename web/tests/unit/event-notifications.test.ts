import { describe, expect, it, vi } from "vitest";
import { createEventNotifications } from "@/lib/notifications/event-notifications";

describe("createEventNotifications", () => {
  it("returns zero when no active recipients exist", async () => {
    const client = {
      catalogAccess: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      eventNotification: {
        findMany: vi.fn(),
        createMany: vi.fn(),
      },
    };

    const result = await createEventNotifications(client, {
      catalogId: "catalog-1",
      eventId: 12,
      title: "Spring Gathering",
    });

    expect(result).toEqual({ created: 0, recipientUserIds: [] });
    expect(client.eventNotification.findMany).not.toHaveBeenCalled();
    expect(client.eventNotification.createMany).not.toHaveBeenCalled();
  });

  it("skips users who were already notified", async () => {
    const client = {
      catalogAccess: {
        findMany: vi.fn().mockResolvedValue([
          { userId: "user-1" },
          { userId: "user-2" },
          { userId: "user-3" },
        ]),
      },
      eventNotification: {
        findMany: vi.fn().mockResolvedValue([{ userId: "user-2" }]),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const result = await createEventNotifications(client, {
      catalogId: "catalog-1",
      eventId: 12,
      title: "Spring Gathering",
    });

    expect(result).toEqual({
      created: 2,
      recipientUserIds: ["user-1", "user-3"],
    });
    expect(client.eventNotification.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          catalogId: "catalog-1",
          eventId: 12,
          title: "Spring Gathering",
        },
        {
          userId: "user-3",
          catalogId: "catalog-1",
          eventId: 12,
          title: "Spring Gathering",
        },
      ],
      skipDuplicates: true,
    });
  });
});
