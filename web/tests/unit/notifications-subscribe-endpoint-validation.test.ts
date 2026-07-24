import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/notifications/subscribe/route";

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

function subscribeRequest(endpoint: string) {
  return new NextRequest("http://localhost/api/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: {
        endpoint,
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
        expirationTime: null,
      },
    }),
  });
}

describe("push subscription endpoint validation", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let upsert: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions"))
      .requireAuth as ReturnType<typeof vi.fn>;
    const prisma = (await import("@/lib/db")).default as unknown as {
      pushSubscription: { upsert: ReturnType<typeof vi.fn> };
    };
    upsert = prisma.pushSubscription.upsert;
    requireAuth.mockResolvedValue("user-1");
    upsert.mockResolvedValue({ id: "sub-1" });
  });

  it.each([
    ["http://push.example.com/send/abc", "non-https scheme"],
    ["https://user:pass@push.example.com/send/abc", "userinfo"],
    ["https://push.example.com:8443/send/abc", "non-standard port"],
    ["https://10.0.0.5/send/abc", "private IPv4 literal"],
    ["https://127.0.0.1/send/abc", "loopback IPv4 literal"],
    ["https://169.254.169.254/latest/meta-data", "link-local IPv4 literal"],
    ["https://[::1]/send/abc", "IPv6 literal"],
    ["https://localhost/send/abc", "localhost"],
    ["https://foo.localhost/send/abc", "localhost subdomain"],
    ["https://metadata.internal/send/abc", "internal hostname"],
    ["https://printer.local/send/abc", "mDNS hostname"],
    ["https://intranet/send/abc", "dotless hostname"],
  ])("rejects %s (%s)", async (endpoint) => {
    const response = await POST(subscribeRequest(endpoint));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("push endpoint");
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc123"],
    ["https://updates.push.services.mozilla.com/wpush/v2/token"],
    ["https://db5p.notify.windows.com/w/?token=abc"],
    ["https://push.example.com:443/send/abc"],
  ])("accepts %s", async (endpoint) => {
    const response = await POST(subscribeRequest(endpoint));

    expect(response.status).toBe(201);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
