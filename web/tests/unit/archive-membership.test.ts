import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/lib/db";
import { ArchiveConfigurationError } from "@/lib/archive";
import { resolveCatalogActorContext, resolvePortalActorContext } from "@/lib/policy/actor";
import { getMcpAccessProfile } from "@/lib/mcp/access-profile";

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: vi.fn() },
    workflowGroup: { findUnique: vi.fn(), findFirst: vi.fn() },
    catalogAccess: { findUnique: vi.fn() },
  },
}));

const ARCHIVE_ID = "20251225_120000";
const FOREIGN_ID = "20260101_120000";
const USER_ID = "member-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BESEDY_ARCHIVE_ID", ARCHIVE_ID);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    status: "ACTIVE", isAdmin: false, isSuperadmin: false,
  } as never);
  vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({
    id: ARCHIVE_ID, label: "Archive", isActive: true,
  } as never);
  vi.mocked(prisma.workflowGroup.findFirst).mockResolvedValue({ id: ARCHIVE_ID } as never);
  vi.mocked(prisma.catalogAccess.findUnique).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("portal entry through the bound archive membership", () => {
  it("requires an existing active bound grant without changing the user's active identity", async () => {
    const actor = await resolvePortalActorContext(USER_ID);

    expect(actor).toEqual({
      userId: USER_ID,
      isAuthenticated: true,
      userStatus: "ACTIVE",
      systemRole: "USER",
      canEnterPortal: false,
    });
    expect(prisma.catalogAccess.findUnique).toHaveBeenCalledWith({
      where: { userId_catalogId: { userId: USER_ID, catalogId: ARCHIVE_ID } },
      select: { status: true },
    });
  });

  it("does not substitute an active foreign grant when the bound grant is revoked", async () => {
    const boundGrant = { status: "REVOKED", role: "listener", extraPermissions: [] };
    const foreignGrant = { status: "ACTIVE", role: "catalog_admin", extraPermissions: [] };
    vi.mocked(prisma.catalogAccess.findUnique).mockImplementation((query) => Promise.resolve(
      query.where.userId_catalogId?.catalogId === FOREIGN_ID ? foreignGrant : boundGrant
    ) as never);

    const actor = await resolveCatalogActorContext(ARCHIVE_ID, USER_ID);

    expect(actor).toMatchObject({
      userStatus: "ACTIVE", canEnterPortal: false, hasCatalogAccess: false,
      isCatalogAdmin: false, catalogGrant: null,
    });
    expect(prisma.catalogAccess.findUnique).toHaveBeenCalledTimes(1);
    expect(boundGrant.status).toBe("REVOKED");
    expect(foreignGrant.status).toBe("ACTIVE");
  });

  it("propagates missing bound membership to the MCP access profile", async () => {
    const profile = await getMcpAccessProfile(USER_ID);

    expect(profile).toEqual({
      userId: USER_ID, canEnterPortal: false, archive: null,
    });
  });

  it.each(["listener", "reader", "corrector", "host", "curator", "catalog_admin"] as const)(
    "retains the bound %s role and extras without copying foreign permissions",
    async (role) => {
      const grant = { status: "ACTIVE", role, extraPermissions: ["bulk_export_transcripts"] };
      vi.mocked(prisma.catalogAccess.findUnique).mockResolvedValue(grant as never);

      const actor = await resolveCatalogActorContext(ARCHIVE_ID, USER_ID);

      expect(actor.canEnterPortal).toBe(true);
      expect(actor.catalogGrant).toEqual({ role, extras: ["bulk_export_transcripts"] });
      for (const [query] of vi.mocked(prisma.catalogAccess.findUnique).mock.calls) {
        expect(query.where.userId_catalogId).toEqual({ userId: USER_ID, catalogId: ARCHIVE_ID });
      }
      expect(grant).toEqual({ status: "ACTIVE", role, extraPermissions: ["bulk_export_transcripts"] });
    },
  );

  it.each([
    { isAdmin: true, isSuperadmin: false, systemRole: "ADMIN" },
    { isAdmin: false, isSuperadmin: true, systemRole: "SUPERADMIN" },
  ])("keeps the active $systemRole bootstrap/administration exception", async (user) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ status: "ACTIVE", ...user } as never);

    const actor = await resolvePortalActorContext(USER_ID);

    expect(actor).toMatchObject({ canEnterPortal: true, systemRole: user.systemRole });
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it.each(["BLOCKED", "PENDING"] as const)("denies %s administrators before checking membership", async (status) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status, isAdmin: true, isSuperadmin: true,
    } as never);

    const actor = await resolvePortalActorContext(USER_ID);

    expect(actor).toMatchObject({ userStatus: status, canEnterPortal: false });
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
    expect(prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
  });

  it("retains the transitional unconfigured runtime without selecting or migrating grants", async () => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", "");

    expect((await resolvePortalActorContext(USER_ID)).canEnterPortal).toBe(true);
    expect(prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, { id: ARCHIVE_ID, isActive: false }])("fails closed when the configured source is unavailable: %j", async (archive) => {
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue(archive as never);

    await expect(resolvePortalActorContext(USER_ID)).rejects.toThrow(ArchiveConfigurationError);
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it("does not let the administration exception hide malformed archive configuration", async () => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", "latest");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE", isAdmin: true, isSuperadmin: false,
    } as never);

    await expect(resolvePortalActorContext(USER_ID)).rejects.toThrow(ArchiveConfigurationError);
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });
});
