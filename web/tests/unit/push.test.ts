import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workflowGroup: {
      findUnique: vi.fn(),
    },
    pushSubscription: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

describe("event push notifications", () => {
  let prisma: {
    workflowGroup: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    pushSubscription: {
      findMany: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let webpush: {
    setVapidDetails: ReturnType<typeof vi.fn>;
    sendNotification: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";

    const dbModule = await import("@/lib/db");
    prisma = dbModule.prisma as unknown as typeof prisma;

    const webpushModule = await import("web-push");
    webpush = webpushModule.default as unknown as typeof webpush;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("sendEventPushNotifications", () => {
    it("returns { sent: 0, failed: 0 } when there are no recipients", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: [],
      });

      expect(result).toEqual({ sent: 0, failed: 0 });
    });

    it("returns { sent: 0, failed: 0 } when no subscriptions exist", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([]);

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(result).toEqual({ sent: 0, failed: 0 });
    });

    it("builds event payload correctly", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "My Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://push.example.com/sub1",
          p256dh: "key1",
          auth: "auth1",
        },
      ]);
      webpush.sendNotification.mockResolvedValue({});

      await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 34,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      const [subscription, payload, options] = webpush.sendNotification.mock.calls[0];
      expect(subscription.endpoint).toBe("https://push.example.com/sub1");
      expect(options).toMatchObject({
        timeout: 10_000,
        agent: expect.any(Object),
      });

      const parsedPayload = JSON.parse(payload);
      expect(parsedPayload.title).toBe("New Event Published");
      expect(parsedPayload.body).toContain("Spring Gathering");
      expect(parsedPayload.body).toContain("My Catalog");
      expect(parsedPayload.data.url).toBe("/catalog/catalog-1/event/34");
    });

    it("removes legacy subscriptions that fail structural validation", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://127.0.0.1/push",
          p256dh: "key1",
          auth: "auth1",
        },
      ]);

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(result).toEqual({ sent: 0, failed: 1 });
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: { in: ["https://127.0.0.1/push"] } },
      });
    });

    it("deletes expired subscriptions after send", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://push.example.com/expired",
          p256dh: "key1",
          auth: "auth1",
        },
      ]);
      webpush.sendNotification.mockRejectedValue({ statusCode: 410 });

      await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: { in: ["https://push.example.com/expired"] } },
      });
    });

    it("prunes subscriptions whose host permanently fails DNS (ENOTFOUND)", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://gone.example.com/sub",
          p256dh: "key1",
          auth: "auth1",
        },
      ]);
      webpush.sendNotification.mockRejectedValue({ code: "ENOTFOUND" });

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(result).toEqual({ sent: 0, failed: 1 });
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: { in: ["https://gone.example.com/sub"] } },
      });
    });

    it("keeps subscriptions on transient DNS failure (EAI_AGAIN)", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://flaky.example.com/sub",
          p256dh: "key1",
          auth: "auth1",
        },
      ]);
      webpush.sendNotification.mockRejectedValue({ code: "EAI_AGAIN" });

      await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    });

    it("updates lastUsedAt only for successful sends", async () => {
      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      prisma.workflowGroup.findUnique.mockResolvedValue({
        label: "Test Catalog",
      });
      prisma.pushSubscription.findMany.mockResolvedValue([
        {
          endpoint: "https://push.example.com/success",
          p256dh: "key1",
          auth: "auth1",
        },
        {
          endpoint: "https://push.example.com/fail",
          p256dh: "key2",
          auth: "auth2",
        },
      ]);
      webpush.sendNotification
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Network error"));

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1", "user-2"],
      });

      expect(result).toEqual({ sent: 1, failed: 1 });
      expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
        where: { endpoint: { in: ["https://push.example.com/success"] } },
        data: { lastUsedAt: expect.any(Date) },
      });
    });
  });

  describe("VAPID configuration", () => {
    it("skips sending when VAPID keys are not configured (non-prod)", async () => {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      process.env.APP_ENV = "development";

      vi.resetModules();

      const { sendEventPushNotifications } = await import("@/lib/notifications/push");
      const webpushModule = await import("web-push");
      const mockedWebpush = webpushModule.default as unknown as typeof webpush;

      const result = await sendEventPushNotifications({
        catalogId: "catalog-1",
        eventId: 12,
        eventTitle: "Spring Gathering",
        recipientUserIds: ["user-1"],
      });

      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(mockedWebpush.setVapidDetails).not.toHaveBeenCalled();
      expect(mockedWebpush.sendNotification).not.toHaveBeenCalled();
    });

    it("throws error when VAPID keys are not configured in production", async () => {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      process.env.APP_ENV = "production";

      vi.resetModules();

      const { sendEventPushNotifications } = await import("@/lib/notifications/push");

      await expect(
        sendEventPushNotifications({
          catalogId: "catalog-1",
          eventId: 12,
          eventTitle: "Spring Gathering",
          recipientUserIds: ["user-1"],
        })
      ).rejects.toThrow(
        "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables are required for push notifications"
      );
    });
  });
});
