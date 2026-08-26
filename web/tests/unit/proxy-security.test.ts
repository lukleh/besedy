import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  resolveRequestAuth: vi.fn(),
  invalidateSessionById: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  invalidateSessionById: mocks.invalidateSessionById,
}));

describe("proxy security controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.APP_ENV = "production";
    process.env.BESEDY_MCP_ENABLED = "true";
    delete process.env.TRUST_PROXY_HEADERS;

    mocks.checkRateLimit.mockReturnValue(true);
    mocks.resolveRequestAuth.mockResolvedValue({
      authenticated: false,
      shouldInvalidateSession: false,
      shouldClearCookies: false,
      sessionId: null,
    });
  });

  it("enforces CSP header in production and removes unsafe-eval", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/health");
    const response = await proxy(request);

    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://www.google.com");
    expect(csp).not.toContain("'unsafe-eval'");
    // script-src is nonce + strict-dynamic, with no 'unsafe-inline'
    expect(csp).toMatch(/script-src [^;]*'nonce-[^']+'/);
    expect(csp).toContain("'strict-dynamic'");
    const scriptSrc = csp?.split(";").find((d: string) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("forwards the same nonce on the request that the response CSP enforces", async () => {
    const { proxy } = await import("@/proxy");
    const request = new NextRequest("http://localhost/api/health");
    const response = await proxy(request);

    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const cspNonce = csp.match(/script-src [^;]*'nonce-([^']+)'/)?.[1];
    expect(cspNonce).toBeTruthy();
    // NextResponse.next({ request: { headers } }) surfaces overridden request
    // headers as x-middleware-request-*. The nonce Next embeds on framework
    // scripts (read from the request CSP header) must equal the nonce the
    // browser enforces (the response CSP) — otherwise every inline script is
    // silently blocked in production.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(cspNonce);
  });

  it("does not trust forwarded IP headers by default for auth rate limiting", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/auth/session", {
      headers: {
        "x-forwarded-for": "203.0.113.20",
        "user-agent": "Mozilla/5.0",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
    const rateLimitKey = mocks.checkRateLimit.mock.calls[0]?.[0] as string;
    expect(rateLimitKey).toMatch(/^auth:fp:[0-9a-f]{8}$/);
  });

  it("treats /auth/complete as a public auth route", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/auth/complete?callbackUrl=%2Fcatalog");
    const response = await proxy(request);

    expect(response.status).toBe(200);
  });

  it("treats /robots.txt as a public route", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/robots.txt");
    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(mocks.resolveRequestAuth).not.toHaveBeenCalled();
  });

  it("redirects anonymous admin page visits to the legacy home redirect", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/admin");
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/");
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
    expect(response.headers.get("X-Web-Version")).toBeTruthy();
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains"
    );
  });

  it("keeps non-admin protected pages on the sign-in redirect with callback state", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/catalog");
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/auth/signin?callbackUrl=%2Fcatalog"
    );
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sanitizes signed-in signin redirects away from internal auth/api targets", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      authenticated: true,
      shouldInvalidateSession: false,
      shouldClearCookies: false,
      sessionId: null,
    });
    const { proxy } = await import("@/proxy");

    const request = new NextRequest(
      "http://localhost/auth/signin?callbackUrl=%2Fapi%2Fauth%2Fsession"
    );
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/catalog");
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'"
    );
  });

  it("normalizes dot-segment callback targets before signed-in signin redirects", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      authenticated: true,
      shouldInvalidateSession: false,
      shouldClearCookies: false,
      sessionId: null,
    });
    const { proxy } = await import("@/proxy");

    const request = new NextRequest(
      "http://localhost/auth/signin?callbackUrl=%2Fcatalog%2F..%2Fapi%2Fauth%2Fsession"
    );
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/catalog");
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
  });

  it("funnels legacy signin callback fallout into auth-complete for old auth tabs", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest(
      "http://localhost/auth/signin?callbackUrl=%2Flabs&state=state_not_found"
    );
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/auth/complete?callbackUrl=%2Flabs&state=state_not_found"
    );
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
  });

  it("applies security headers to allowlist rejection redirects", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest(
      "http://localhost/auth/signin?error=access_denied&error_description=not_authorized%3Auser%40example.com"
    );
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/auth/unauthorized?error=not_authorized%3Auser%40example.com"
    );
    expect(response.headers.get("X-App-Commit")).toBeTruthy();
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("rate limits CSP reporting endpoints", async () => {
    mocks.checkRateLimit.mockReturnValue(false);
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/csp-report", {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const rateLimitKey = mocks.checkRateLimit.mock.calls[0]?.[0] as string;
    expect(rateLimitKey).toMatch(/^csp-report:fp:[0-9a-f]{8}$/);
  });

  it("rejects mutating API requests without a trusted source origin", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/preferences", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ theme: "system" }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request origin",
    });
  });

  it("allows authorized internal deep-search service mutations without browser origin", async () => {
    process.env.BESEDY_JOB_SERVICE_SECRET = "test-job-secret";
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: {
        authorization: "Bearer test-job-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
  });

  it("rejects unauthenticated internal deep-search service mutations without browser origin", async () => {
    process.env.BESEDY_JOB_SERVICE_SECRET = "test-job-secret";
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/internal/deep-search/search", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ catalogId: "catalog-1", query: "brno" }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid request origin",
    });
  });

  it("allows bearer-authenticated MCP POST requests without a browser origin", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer mcp-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
  });

  it("keeps MCP POST requests without a bearer token behind CSRF validation", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(403);
  });

  it("does not exempt MCP bearer requests from CSRF when MCP is disabled", async () => {
    process.env.BESEDY_MCP_ENABLED = "false";
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer mcp-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(403);
  });

  it("allows mutating API requests from the same origin to reach the route handler", async () => {
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/preferences", {
      method: "PATCH",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ theme: "system" }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'"
    );
  });

  it("allows headerless mutating API requests in the test app environment", async () => {
    process.env.APP_ENV = "test";
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/preferences", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ theme: "system" }),
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
  });

  it("uses forwarded headers only when TRUST_PROXY_HEADERS is enabled", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/auth/session", {
      headers: {
        "x-forwarded-for": "203.0.113.20, 198.51.100.2",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("auth:ip:203.0.113.20", 30, 60_000);
  });

  it("logs pass-through requests distinctly from terminal middleware responses", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { proxy } = await import("@/proxy");

    const request = new NextRequest("http://localhost/api/health");
    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(" GET /api/health pass "));

    logSpy.mockRestore();
  });
});
