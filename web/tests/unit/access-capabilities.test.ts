import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdminCapability,
  getCatalogCapability,
  getPortalCapability,
  getRecordingCapability,
} from "@/lib/access/capabilities";
import * as session from "@/lib/auth/session";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session"
  );
  return {
    ...actual,
    getCurrentUserId: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    workflowGroup: {
      findFirst: vi.fn(),
    },
    catalogAccess: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    catalogEntry: {
      findUnique: vi.fn(),
    },
  },
}));

describe("access capabilities", () => {
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    catalogAccess: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    catalogEntry: { findUnique: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("returns unauthenticated portal capability when no user is logged in", async () => {
    vi.mocked(session.getCurrentUserId).mockResolvedValue(null);

    const result = await getPortalCapability();

    expect(result).toEqual({
      userId: null,
      isAuthenticated: false,
      userStatus: null,
      canEnterPortal: false,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns admin capability flags for an active admin", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: true,
      isSuperadmin: false,
    });

    const result = await getAdminCapability("admin-1");

    expect(result).toMatchObject({
      userId: "admin-1",
      isAuthenticated: true,
      userStatus: "ACTIVE",
      canEnterPortal: true,
      isSuperadmin: false,
      isAdmin: true,
      canAccessAdmin: true,
      hasEditorOnAnyCatalog: true,
    });
  });

  it("derives catalog permissions from a typed capability object", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "user-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: "VIEWER",
      accessLevel: "VIEWER",
      isCatalogAdmin: false,
      canViewCatalog: true,
      canViewTranscripts: true,
      canDownload: false,
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageAccess: false,
      canAccessSettings: false,
      canManageCatalogConfiguration: false,
      canUseRagSearch: true,
    });
    expect(prisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });

  it("grants owner management flags from access level alone", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "OWNER",
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "owner-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: "OWNER",
      accessLevel: "OWNER",
      isCatalogAdmin: false,
      canEditMetadata: true,
      canBatchEditMetadata: true,
      canManageAccess: true,
      canAccessSettings: true,
      canManageCatalogConfiguration: false,
    });
    expect(prisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });

  it("preserves catalog-admin authority separately from owner grants", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: true,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });

    const result = await getCatalogCapability("catalog-1", "admin-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: null,
      accessLevel: "OWNER",
      isCatalogAdmin: true,
      canManageAccess: true,
      canAccessSettings: true,
      canManageCatalogConfiguration: true,
    });
  });

  it("short-circuits with null access when the catalog does not exist", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue(null);

    const result = await getCatalogCapability("missing-catalog", "owner-1");

    expect(result).toMatchObject({
      catalogId: "missing-catalog",
      catalogExists: false,
      hasAccess: false,
      catalogGrant: null,
      accessLevel: null,
      isCatalogAdmin: false,
      canViewCatalog: false,
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageAccess: false,
      canAccessSettings: false,
      canManageCatalogConfiguration: false,
      canUseRagSearch: false,
    });
  });

  it("applies listener recording visibility before granting access", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogEntry.findUnique.mockResolvedValue({
      isActionable: true,
      isPublished: false,
    });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "LISTENER",
      status: "ACTIVE",
    });

    const result = await getRecordingCapability("catalog-1", "hash-1", "listener-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      accessLevel: "LISTENER",
      hasAccess: true,
      canAccessRecording: false,
      canStreamAudio: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: false,
      canUseRagSearch: false,
    });
  });

  it("allows owners to resolve inactive catalog settings when explicitly requested", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockImplementation(
      ({
        where,
      }: {
        where: { id: string; isActive?: boolean };
      }) =>
        Promise.resolve(
          where.isActive === undefined ? { id: "catalog-1" } : null
        )
    );
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "OWNER",
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "owner-1", {
      activeCatalogOnly: false,
    });

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      canAccessSettings: true,
    });
    expect(prisma.workflowGroup.findFirst).toHaveBeenCalledWith({
      where: { id: "catalog-1" },
      select: { id: true },
    });
  });

  it("denies VIEWER recording capabilities when the catalog entry is missing", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "ACTIVE",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const result = await getRecordingCapability("catalog-1", "hash-1", "viewer-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      accessLevel: "VIEWER",
      hasAccess: true,
      canAccessRecording: false,
      canStreamAudio: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: false,
    });
  });

  it("preserves edit capability for editors when the recording entry is missing", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "EDITOR",
      status: "ACTIVE",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const result = await getRecordingCapability("catalog-1", "hash-1", "editor-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      accessLevel: "EDITOR",
      hasAccess: true,
      canAccessRecording: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: true,
    });
  });
});
