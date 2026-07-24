import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/notifications/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    eventNotification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

describe("notifications route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    eventNotification: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  describe("GET /api/notifications", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValue(new Error("Authentication required"));

      const request = new NextRequest("http://localhost/api/notifications");
      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns notifications for authenticated user", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([
        {
          id: "notif-1",
          catalogId: "catalog-1",
          eventId: 7,
          title: "Published Event",
          isRead: false,
          createdAt: new Date("2025-01-01"),
          catalog: { label: "Test Catalog" },
        },
      ]);
      prisma.eventNotification.count.mockResolvedValue(1);

      const request = new NextRequest("http://localhost/api/notifications");
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0].id).toBe("notif-1");
      expect(body.unreadCount).toBe(1);
    });

    it("respects unread=true filter", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([]);
      prisma.eventNotification.count.mockResolvedValue(0);

      const request = new NextRequest("http://localhost/api/notifications?unread=true");
      await GET(request);

      expect(prisma.eventNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            isRead: false,
          }),
        })
      );
    });

    it("respects catalogId filter", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([]);
      prisma.eventNotification.count.mockResolvedValue(0);

      const request = new NextRequest("http://localhost/api/notifications?catalogId=catalog-1");
      await GET(request);

      expect(prisma.eventNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            catalogId: "catalog-1",
          }),
        })
      );
    });

    it("orders by createdAt desc and limits to 50", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([]);
      prisma.eventNotification.count.mockResolvedValue(0);

      const request = new NextRequest("http://localhost/api/notifications");
      await GET(request);

      expect(prisma.eventNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      );
    });

    it("includes catalog.label in response", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([]);
      prisma.eventNotification.count.mockResolvedValue(0);

      const request = new NextRequest("http://localhost/api/notifications");
      await GET(request);

      expect(prisma.eventNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            catalog: { select: { label: true } },
          }),
        })
      );
    });

    /**
     * Test that the API handles notifications where the catalog has been deleted.
     *
     * This can happen if:
     * 1. A notification is created for an event in a catalog
     * 2. The catalog (WorkflowGroup) is later deleted
     * 3. The notification remains (cascade delete should handle this, but belt-and-suspenders)
     *
     * The frontend should handle catalog: null gracefully.
     */
    it("handles notification with null catalog (deleted catalog)", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.findMany.mockResolvedValue([
        {
          id: "notif-1",
          catalogId: "deleted-catalog",
          eventId: 42,
          title: "Event in deleted catalog",
          isRead: false,
          createdAt: new Date("2025-01-01"),
          catalog: null, // Catalog was deleted
        },
      ]);
      prisma.eventNotification.count.mockResolvedValue(1);

      const request = new NextRequest("http://localhost/api/notifications");
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0].catalog).toBeNull();
      // The frontend (NotificationBell) should use optional chaining: notification.catalog?.label
    });
  });

  describe("PATCH /api/notifications", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValue(new Error("Authentication required"));

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAllRead: true }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it("returns 400 for invalid body", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: "invalid" }), // Should be array
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
    });

    it("marks specific notifications as read by ID", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.updateMany.mockResolvedValue({ count: 2 });

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: ["notif-1", "notif-2"] }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      expect(prisma.eventNotification.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["notif-1", "notif-2"] },
          userId: "user-1", // Security check
        },
        data: { isRead: true, readAt: expect.any(Date) },
      });
    });

    it("only updates own notifications (security)", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.updateMany.mockResolvedValue({ count: 0 });

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: ["other-user-notif"] }),
      });
      await PATCH(request);

      // The userId filter ensures only own notifications are updated
      expect(prisma.eventNotification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
          }),
        })
      );
    });

    it("marks all as read when markAllRead: true", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.updateMany.mockResolvedValue({ count: 5 });

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAllRead: true }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      expect(prisma.eventNotification.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", isRead: false },
        data: { isRead: true, readAt: expect.any(Date) },
      });
    });

    it("sets readAt timestamp", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.eventNotification.updateMany.mockResolvedValue({ count: 1 });

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: ["notif-1"] }),
      });
      await PATCH(request);

      expect(prisma.eventNotification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            readAt: expect.any(Date),
          }),
        })
      );
    });

    it("returns success even when no-op (empty notificationIds)", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: [] }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
      // No updateMany call because array is empty
      expect(prisma.eventNotification.updateMany).not.toHaveBeenCalled();
    });
  });
});
