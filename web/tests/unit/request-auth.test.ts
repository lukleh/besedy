import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RequestAuthReason,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("better-auth/cookies", () => ({
  SECURE_COOKIE_PREFIX: "__Secure-",
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
    },
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    session: {
      delete: mocks.deleteSession,
    },
  },
}));

function makeCookie(name: string, value: string): string {
  return `${name}=${value}`;
}

function makeRequest(cookieHeader?: string): Request {
  return new Request("http://localhost:3001/catalog", {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}

describe("resolveRequestAuth", () => {
  const originalAppEnv = process.env.APP_ENV;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_ENV = "test";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }
  });

  it("returns unauthenticated when no session cookie exists", async () => {
    const result = await resolveRequestAuth(makeRequest());

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.NO_SESSION_COOKIE);
    expect(result.shouldClearCookies).toBe(false);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("treats plain cookie as unauthenticated in production", async () => {
    process.env.APP_ENV = "production";

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "legacy-cookie"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.NO_SESSION_COOKIE);
    expect(result.shouldClearCookies).toBe(false);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("clears stale cookies when Better Auth cannot resolve a session", async () => {
    mocks.getSession.mockResolvedValue(null);

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "stale-cookie"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.SESSION_NOT_FOUND);
    expect(result.shouldClearCookies).toBe(true);
    expect(result.shouldInvalidateSession).toBe(false);
    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: {
        disableCookieCache: true,
        disableRefresh: true,
      },
    });
  });

  it("passes only secure auth cookies to Better Auth in production", async () => {
    process.env.APP_ENV = "production";
    mocks.getSession.mockResolvedValue(null);

    await resolveRequestAuth(
      makeRequest(
        [
          makeCookie("besedy.session_token", "plain-token"),
          makeCookie("__Secure-besedy.session_token", "secure-token"),
          makeCookie("besedy.session_data", "plain-cache"),
          makeCookie("__Secure-besedy.session_data", "secure-cache"),
          makeCookie("theme", "dark"),
        ].join("; ")
      )
    );

    const headers = mocks.getSession.mock.calls[0]?.[0]?.headers as Headers;
    expect(headers.get("cookie")).toBe(
      "__Secure-besedy.session_token=secure-token; __Secure-besedy.session_data=secure-cache; theme=dark"
    );
  });

  it("passes only the selected plain auth cookies to Better Auth outside production", async () => {
    mocks.getSession.mockResolvedValue(null);

    await resolveRequestAuth(
      makeRequest(
        [
          makeCookie("besedy.session_token", "plain-token"),
          makeCookie("__Secure-besedy.session_token", "secure-token"),
          makeCookie("besedy.session_data", "plain-cache"),
          makeCookie("__Secure-besedy.session_data", "secure-cache"),
          makeCookie("theme", "dark"),
        ].join("; ")
      )
    );

    const headers = mocks.getSession.mock.calls[0]?.[0]?.headers as Headers;
    expect(headers.get("cookie")).toBe(
      "besedy.session_token=plain-token; besedy.session_data=plain-cache; theme=dark"
    );
  });

  it("returns session_expired for expired sessions", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-1",
        token: "token-expired",
        expiresAt: new Date(Date.now() - 60_000),
      },
      user: {
        id: "user-1",
        email: "user@example.com",
        emailVerified: true,
        name: "Expired User",
        image: null,
        status: "ACTIVE",
      },
    });

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-expired"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.SESSION_EXPIRED);
    expect(result.sessionId).toBe("session-1");
    expect(result.shouldClearCookies).toBe(true);
    expect(result.shouldInvalidateSession).toBe(true);
  });

  it("returns session_user_missing when session has no user", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-2",
        token: "token-no-user",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: null,
    });

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-no-user"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.SESSION_USER_MISSING);
    expect(result.shouldClearCookies).toBe(true);
    expect(result.shouldInvalidateSession).toBe(true);
  });

  it("treats PENDING user as signed-out", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-3",
        token: "token-pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: "user-pending",
        email: "pending@example.com",
        emailVerified: false,
        name: "Pending User",
        image: null,
        status: "PENDING",
      },
    });

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-pending"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.USER_NOT_ACTIVE);
    expect(result.userStatus).toBe("PENDING");
    expect(result.shouldClearCookies).toBe(true);
    expect(result.shouldInvalidateSession).toBe(true);
  });

  it("treats BLOCKED user as signed-out", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-4",
        token: "token-blocked",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: "user-blocked",
        email: "blocked@example.com",
        emailVerified: true,
        name: "Blocked User",
        image: null,
        status: "BLOCKED",
      },
    });

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-blocked"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.USER_NOT_ACTIVE);
    expect(result.userStatus).toBe("BLOCKED");
    expect(result.shouldClearCookies).toBe(true);
    expect(result.shouldInvalidateSession).toBe(true);
  });

  it("returns authenticated for ACTIVE user with valid session", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-5",
        token: "token-active",
        expiresAt,
      },
      user: {
        id: "user-active",
        email: "active@example.com",
        emailVerified: true,
        name: "Active User",
        image: "https://example.com/avatar.png",
        status: "ACTIVE",
      },
    });

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-active"))
    );

    expect(result.authenticated).toBe(true);
    expect(result.reason).toBe(RequestAuthReason.AUTHENTICATED);
    expect(result.userId).toBe("user-active");
    expect(result.sessionId).toBe("session-5");
    expect(result.sessionToken).toBe("token-active");
    expect(result.sessionExpiresAt).toEqual(expiresAt);
    expect(result.userStatus).toBe("ACTIVE");
    expect(result.shouldClearCookies).toBe(false);
    expect(result.shouldInvalidateSession).toBe(false);
  });

  it("returns internal_error when Better Auth session resolution throws", async () => {
    mocks.getSession.mockRejectedValue(new Error("boom"));

    const result = await resolveRequestAuth(
      makeRequest(makeCookie("besedy.session_token", "token-error"))
    );

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe(RequestAuthReason.INTERNAL_ERROR);
    expect(result.shouldClearCookies).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "[request-auth] Better Auth session resolution failed",
      expect.objectContaining({
        surface: "unknown",
        path: "/catalog",
        method: "GET",
        error: expect.any(Error),
      })
    );
  });
});
