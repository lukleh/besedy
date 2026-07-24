import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/preferences/labs/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    userPreferences: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

describe("preferences labs route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    userPreferences: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("GET returns default labs preference when settings are missing", async () => {
    requireAuth.mockResolvedValue("user-1");
    prisma.userPreferences.findUnique.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ enabled: false, updatedAt: null });
  });

  it("PUT merges labs setting without dropping unrelated settings", async () => {
    requireAuth.mockResolvedValue("user-1");
    prisma.userPreferences.findUnique.mockResolvedValue({
      settings: {
        audioSources: { "catalog:hash": "source-a" },
        catalogTabs: { "20260201_120000": "recordings" },
      },
    });
    prisma.userPreferences.upsert.mockImplementation(async (args: { update: { settings: object } }) => ({
      settings: args.update.settings,
    }));

    const request = new NextRequest("http://localhost/api/preferences/labs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        updatedAt: "1999-01-01T00:00:00.000Z",
      }),
    });
    const response = await PUT(request);

    expect(response.status).toBe(200);
    expect(prisma.userPreferences.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = prisma.userPreferences.upsert.mock.calls[0][0];
    const mergedSettings = upsertArgs.update.settings as Record<string, unknown>;

    expect(mergedSettings.audioSources).toEqual({ "catalog:hash": "source-a" });
    expect(mergedSettings.catalogTabs).toEqual({ "20260201_120000": "recordings" });
    expect(mergedSettings.labs).toEqual(
      expect.objectContaining({
        enabled: true,
        updatedAt: expect.any(String),
      })
    );

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.updatedAt).toBe("string");
    expect(body.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});
