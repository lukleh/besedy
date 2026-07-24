import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAudioSources } from "@/app/api/catalogs/[id]/recordings/[hash]/audio/sources/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowVariant: {
      findMany: vi.fn(),
    },
    catalogListeningEntry: {
      findUnique: vi.fn(),
    },
  },
}));

describe("catalog audio sources route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowVariant: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("rejects invalid hash format", async () => {
    const request = new NextRequest(
      "http://localhost/api/catalogs/20250101_120000/recordings/invalid-hash/audio/sources"
    );
    const response = await getAudioSources(request, {
      params: Promise.resolve({ id: "20250101_120000", hash: "invalid-hash" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid route parameters/);
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("denies access before loading variants", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      canAccessRecording: false,
    });

    const request = new NextRequest(
      "http://localhost/api/catalogs/20250101_120000/recordings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio/sources"
    );
    const response = await getAudioSources(request, {
      params: Promise.resolve({
        id: "20250101_120000",
        hash: "a".repeat(64),
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
    expect(prisma.workflowVariant.findMany).not.toHaveBeenCalled();
  });
});
