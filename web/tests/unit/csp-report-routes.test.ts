import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postClientError } from "@/app/api/csp-report/client-error/route";
import { POST as postCspReport } from "@/app/api/csp-report/route";

vi.mock("@/lib/db", () => ({
  default: {
    clientErrorReport: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentUserId: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
  },
}));

vi.mock("@/lib/log/server", () => ({
  createServerLogger: vi.fn(() => mockLogger),
}));

describe("csp-report routes", () => {
  let prisma: {
    clientErrorReport: {
      create: ReturnType<typeof vi.fn>;
    };
  };
  let getCurrentUserId: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    getCurrentUserId = (await import("@/lib/auth/permissions")).getCurrentUserId as ReturnType<typeof vi.fn>;
    getCurrentUserId.mockResolvedValue("user-1");
  });

  it("rejects oversized client-error payloads even without Content-Length", async () => {
    const request = new NextRequest("http://localhost/api/csp-report/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "x".repeat(70_000),
      }),
    });

    const response = await postClientError(request);

    expect(response.status).toBe(413);
    expect(prisma.clientErrorReport.create).not.toHaveBeenCalled();
  });

  it("rejects oversized CSP payloads after reading request body", async () => {
    const request = new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "http://localhost",
          "script-sample": "x".repeat(12_000),
        },
      }),
    });

    const response = await postCspReport(request);

    expect(response.status).toBe(413);
  });

  it("rejects malformed client-error JSON with a warning", async () => {
    const request = new NextRequest("http://localhost/api/csp-report/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await postClientError(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Rejected malformed client error report JSON",
      expect.objectContaining({
        error: expect.any(String),
      }),
    );
    expect(prisma.clientErrorReport.create).not.toHaveBeenCalled();
  });
});
