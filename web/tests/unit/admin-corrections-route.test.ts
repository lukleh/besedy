import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({
  loadOverview: vi.fn(),
  requireAdmin: vi.fn(),
  requireArchive: vi.fn(),
}));

vi.mock("@/lib/access/require-admin", () => ({
  requireAdminCapability: mocks.requireAdmin,
}));

vi.mock("@/lib/archive", () => ({
  requireArchive: mocks.requireArchive,
}));

vi.mock("@/lib/correction/admin-overview", () => ({
  loadCorrectionAdminOverview: mocks.loadOverview,
}));

import { GET } from "@/app/api/admin/corrections/route";

describe("admin corrections route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: "admin-1" });
    mocks.requireArchive.mockResolvedValue({ id: "20251225_120000", label: null });
    mocks.loadOverview.mockResolvedValue({ people: [] });
  });

  it("loads the configured catalog for an administrator, unreleased material included", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ catalogId: "20251225_120000", people: [] });
    expect(mocks.loadOverview).toHaveBeenCalledWith({
      catalogId: "20251225_120000",
      actorKey: "admin-1",
      canSeeUnreleased: true,
    });
  });

  it("refuses everyone else before reading anything", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthError("Admin access required", 403));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.loadOverview).not.toHaveBeenCalled();
  });
});
