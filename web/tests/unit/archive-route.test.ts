import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/archive/route";
import { ArchiveConfigurationError } from "@/lib/archive";
import { AuthError } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), archive: vi.fn(), capability: vi.fn() }));
vi.mock("@/lib/auth/permissions", async (original) => ({ ...await original<typeof import("@/lib/auth/permissions")>(), requireAuth: mocks.auth }));
vi.mock("@/lib/archive", async (original) => ({ ...await original<typeof import("@/lib/archive")>(), requireArchive: mocks.archive }));
vi.mock("@/lib/access/capabilities", () => ({ getCatalogCapability: mocks.capability }));

describe("GET /api/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue("user-1");
    mocks.archive.mockResolvedValue({ id: "bound", label: "Besedy" });
    mocks.capability.mockResolvedValue({ hasAccess: true });
  });

  it("returns only the configured archive after the actor's access check", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "bound", label: "Besedy" });
    expect(mocks.capability).toHaveBeenCalledWith("bound", "user-1");
  });

  it("denies a signed-in user without archive access", async () => {
    mocks.capability.mockResolvedValue({ hasAccess: false });
    expect((await GET()).status).toBe(403);
  });

  it("requires authentication before resolving deployment data", async () => {
    mocks.auth.mockRejectedValue(new AuthError("Authentication required", 401));
    expect((await GET()).status).toBe(401);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("reports missing archive configuration instead of selecting a source", async () => {
    mocks.archive.mockRejectedValue(new ArchiveConfigurationError("BESEDY_ARCHIVE_ID is required"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "BESEDY_ARCHIVE_ID is required" });
    expect(mocks.capability).not.toHaveBeenCalled();
  });
});
