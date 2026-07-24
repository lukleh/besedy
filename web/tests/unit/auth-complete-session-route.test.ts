import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  invalidateSessionById: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  invalidateSessionById: mocks.invalidateSessionById,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

describe("auth complete session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      authenticated: true,
      shouldClearCookies: false,
      shouldInvalidateSession: false,
      sessionId: null,
    });
  });

  it("returns authenticated true for canonical active sessions", async () => {
    const { GET } = await import("@/app/api/auth-complete/session/route");
    const request = new NextRequest("http://localhost/api/auth-complete/session");

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ authenticated: true });
  });

  it("returns authenticated false and applies cleanup for blocked or stale sessions", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      authenticated: false,
      reason: "user_not_active",
      shouldClearCookies: true,
      shouldInvalidateSession: true,
      sessionId: "session-1",
    });
    const { GET } = await import("@/app/api/auth-complete/session/route");
    const request = new NextRequest("http://localhost/api/auth-complete/session", {
      headers: {
        cookie:
          "besedy.session_token=token; besedy.session_data=data; besedy.session_data.0=chunk",
      },
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(mocks.invalidateSessionById).toHaveBeenCalledWith("session-1");
    expect(response.headers.get("set-cookie")).toContain("besedy.session_token=;");
    expect(response.headers.get("set-cookie")).toContain("besedy.session_data=;");
  });
});
