import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { WebUpdateEventType } from "@/generated/prisma/enums";
import { POST } from "@/app/api/web-update-events/route";
import { clearAllRateLimits } from "@/lib/security/rate-limit";

const mocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({}),
  getCurrentUserId: vi.fn().mockResolvedValue("user-1"),
}));

vi.mock("@/lib/db", () => ({
  default: { webUpdateEvent: { create: mocks.create } },
}));

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

function request(body: unknown) {
  return new NextRequest("http://localhost/api/web-update-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      "x-forwarded-for": "192.0.2.10",
    },
    body: JSON.stringify(body),
  });
}

describe("web update telemetry endpoint", () => {
  beforeEach(() => {
    clearAllRateLimits();
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({});
    mocks.getCurrentUserId.mockResolvedValue("user-1");
  });

  it("stores only allowlisted lifecycle fields", async () => {
    const response = await POST(
      request({
        event: "apply_blocked",
        attemptId: "d7348d7d-f8a3-4fe5-b8e0-c939245c79c2",
        clientVersion: "web-a",
        targetVersion: "web-b",
        workerReady: true,
        blockerKinds: ["unsaved-changes", "private-note", "unsaved-changes"],
        routeGroup: "/catalog/private-id/event/42",
        arbitrary: "must not be stored",
      })
    );

    expect(response.status).toBe(202);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        event: WebUpdateEventType.APPLY_BLOCKED,
        attemptId: "d7348d7d-f8a3-4fe5-b8e0-c939245c79c2",
        clientVersion: "web-a",
        targetVersion: "web-b",
        workerReady: true,
        blockerKinds: ["unsaved-changes"],
        routeGroup: null,
        browser: "Chrome",
      },
    });
  });

  it("rejects unknown event names and invalid attempt IDs", async () => {
    const unknownEvent = await POST(request({ event: "anything", attemptId: "attempt-1" }));
    const invalidAttempt = await POST(
      request({ event: "client_seen", attemptId: "contains private spaces" })
    );

    expect(unknownEvent.status).toBe(400);
    expect(invalidAttempt.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stores delayed activation events", async () => {
    const response = await POST(
      request({ event: "activation_delayed", attemptId: "slow-attempt-1" })
    );

    expect(response.status).toBe(202);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: WebUpdateEventType.ACTIVATION_DELAYED,
        attemptId: "slow-attempt-1",
      }),
    });
  });

  it("acknowledges storage failures so clients do not retry", async () => {
    mocks.create.mockRejectedValueOnce(new Error("migration pending"));

    const response = await POST(request({ event: "client_seen", attemptId: "attempt-1" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: false });
  });
});
