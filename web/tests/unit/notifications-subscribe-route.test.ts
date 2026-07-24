import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST, DELETE } from "@/app/api/notifications/subscribe/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    pushSubscription: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

describe("notifications subscribe route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    pushSubscription: {
      upsert: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  describe("POST /api/notifications/subscribe", () => {
    const validSubscription = {
      subscription: {
        endpoint: "https://push.example.com/subscription/abc",
        keys: {
          p256dh: "test-public-key-value",
          auth: "test-auth-value",
        },
        expirationTime: null,
      },
    };

    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValue(new Error("Authentication required"));

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSubscription),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 for invalid subscription data", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: { endpoint: "not-a-url" } }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid subscription data");
    });

    it("returns 400 when endpoint is missing", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: {
            keys: { p256dh: "key", auth: "auth" },
          },
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it("returns 400 when keys are missing", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: {
            endpoint: "https://push.example.com/sub",
          },
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it("creates new subscription successfully", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.upsert.mockResolvedValue({
        id: "sub-1",
        userId: "user-1",
        endpoint: validSubscription.subscription.endpoint,
        p256dh: validSubscription.subscription.keys.p256dh,
        auth: validSubscription.subscription.keys.auth,
        userAgent: "Test Browser",
        createdAt: new Date(),
      });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Test Browser",
        },
        body: JSON.stringify(validSubscription),
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("sub-1");
      expect(body.message).toBe("Subscribed successfully");
    });

    it("upserts if endpoint already exists for same user", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.upsert.mockResolvedValue({
        id: "sub-1",
        userId: "user-1",
        endpoint: validSubscription.subscription.endpoint,
      });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSubscription),
      });
      await POST(request);

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
        where: { endpoint: validSubscription.subscription.endpoint },
        create: expect.objectContaining({
          userId: "user-1",
          endpoint: validSubscription.subscription.endpoint,
          p256dh: validSubscription.subscription.keys.p256dh,
          auth: validSubscription.subscription.keys.auth,
        }),
        update: expect.objectContaining({
          userId: "user-1",
          p256dh: validSubscription.subscription.keys.p256dh,
          auth: validSubscription.subscription.keys.auth,
        }),
      });
    });

    it("reassigns a shared-browser endpoint to the current user", async () => {
      // User 1 subscribes first
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.upsert.mockResolvedValue({
        id: "sub-1",
        userId: "user-1",
        endpoint: validSubscription.subscription.endpoint,
      });

      const request1 = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSubscription),
      });
      await POST(request1);

      // User 2 subscribes with SAME endpoint (shared device scenario)
      vi.mocked(requireAuth).mockResolvedValue("user-2");
      prisma.pushSubscription.upsert.mockResolvedValue({
        id: "sub-1",
        userId: "user-2", // Now owned by user-2!
        endpoint: validSubscription.subscription.endpoint,
      });

      const request2 = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSubscription),
      });
      await POST(request2);

      const secondCall = prisma.pushSubscription.upsert.mock.calls[1][0];
      expect(secondCall.where).toEqual({
        endpoint: validSubscription.subscription.endpoint,
      });
      expect(secondCall.update.userId).toBe("user-2");
    });

    it("captures userAgent from request", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.upsert.mockResolvedValue({ id: "sub-1" });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        },
        body: JSON.stringify(validSubscription),
      });
      await POST(request);

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          }),
        })
      );
    });
  });

  describe("DELETE /api/notifications/subscribe", () => {
    const validEndpoint = "https://push.example.com/subscription/abc";

    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValue(new Error("Authentication required"));

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: validEndpoint }),
      });
      const response = await DELETE(request);

      expect(response.status).toBe(401);
    });

    it("returns 400 for invalid endpoint", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "not-a-url" }),
      });
      const response = await DELETE(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
    });

    it("returns 404 when subscription not found", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: validEndpoint }),
      });
      const response = await DELETE(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Subscription not found");
    });

    it("returns 404 when subscription belongs to different user", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      // deleteMany returns 0 because userId doesn't match
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: validEndpoint }),
      });
      const response = await DELETE(request);

      expect(response.status).toBe(404);
      // Security: userId filter prevents deleting others' subscriptions
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: {
          endpoint: validEndpoint,
          userId: "user-1",
        },
      });
    });

    it("returns 204 on successful deletion", async () => {
      vi.mocked(requireAuth).mockResolvedValue("user-1");
      prisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });

      const request = new NextRequest("http://localhost/api/notifications/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: validEndpoint }),
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);
    });
  });
});
