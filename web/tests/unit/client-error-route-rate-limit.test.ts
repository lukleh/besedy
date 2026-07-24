import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/csp-report/client-error/route";
import { checkRateLimit, clearAllRateLimits } from "@/lib/security/rate-limit";

// Must match GLOBAL_RATE_LIMIT / RATE_LIMIT_WINDOW_MS in the route.
const GLOBAL_RATE_LIMIT = 600;
const WINDOW_MS = 60 * 1000;
const GLOBAL_KEY = "client-error:global";

vi.mock("@/lib/db", () => ({
  default: { clientErrorReport: { create: vi.fn().mockResolvedValue({}) } },
}));

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentUserId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/log/server", () => ({
  createServerLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function reportRequest(body: string) {
  return new NextRequest("http://localhost/api/csp-report/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function exhaustGlobalBudget() {
  for (let i = 0; i < GLOBAL_RATE_LIMIT; i += 1) {
    checkRateLimit(GLOBAL_KEY, GLOBAL_RATE_LIMIT, WINDOW_MS);
  }
}

describe("client-error route global rate limit", () => {
  beforeEach(() => {
    clearAllRateLimits();
    vi.clearAllMocks();
  });

  it("accepts a valid report while under the global cap", async () => {
    const response = await POST(reportRequest(JSON.stringify({ message: "boom" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  it("returns 429 once the global cap is exhausted", async () => {
    exhaustGlobalBudget();

    const response = await POST(reportRequest(JSON.stringify({ message: "boom" })));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("rejects malformed payloads before the global cap, so they never consume it", async () => {
    exhaustGlobalBudget();

    // Global budget is spent, but a malformed body is rejected by structural
    // validation first — it returns 400, not 429, proving the cap sits after
    // validation and garbage cannot exhaust the shared budget.
    const response = await POST(reportRequest("not json"));

    expect(response.status).toBe(400);
  });
});
