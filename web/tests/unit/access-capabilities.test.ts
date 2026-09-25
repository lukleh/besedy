import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdminCapability,
  getCatalogCapability,
  getPortalCapability,
  getRecordingCapability,
} from "@/lib/access/capabilities";
import * as session from "@/lib/auth/session";
import { grantForRole } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
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
    });
    expect(session.getCurrentUserId).not.toHaveBeenCalled();
  });

  it("derives catalog permissions from a reader grant", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "reader",
      extraPermissions: [],
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "user-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: grantForRole("reader"),
      isCatalogAdmin: false,
      canViewCatalog: true,
      canViewTranscripts: true,
      // A reader reads; every delivery is a permission of its own now.
      canDownloadAudio: false,
      canDownloadTranscripts: false,
      canBulkExportTranscripts: false,
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageLookups: false,
      canManageAccess: false,
      canAccessSettings: false,
      canManageCatalogConfiguration: false,
      // read_transcripts and search_transcripts both come with the reader bundle.
      canUseRagSearch: true,
      // Artwork candidates need see_unreleased or a artwork permission; a
      // reader carries none of them.
      canViewArtworkCandidates: false,
      canManageArtwork: false,
      canPublishArtwork: false,
      canManageEventSources: false,
    });
    expect(prisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });

  it("grants host access-management flags without the editorial permissions", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "host",
      extraPermissions: [],
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "host-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: grantForRole("host"),
      isCatalogAdmin: false,
      canManageAccess: true,
      canAccessSettings: true,
      canManageCatalogConfiguration: false,
      // Host is reader-plus-manage_access; the editorial permissions belong
      // to the curator instead.
      canEditMetadata: false,
      canBatchEditMetadata: false,
      canManageLookups: false,
      canViewArtworkCandidates: false,
      canManageArtwork: false,
      canPublishArtwork: false,
      // Sources are editorial too; the host does not get them with
      // manage_access any more.
      canManageEventSources: false,
    });
    expect(prisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });

  it("grants curator editorial flags without access-management authority", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "curator",
      extraPermissions: [],
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "curator-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      catalogExists: true,
      hasAccess: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
      canEditMetadata: true,
      canBatchEditMetadata: true,
      canManageLookups: true,
      canManageCatalogConfiguration: false,
      canViewArtworkCandidates: true,
      canManageArtwork: true,
      canPublishArtwork: true,
      canManageEventSources: true,
      // The editorial role does not manage who else has access.
      canManageAccess: false,
      canAccessSettings: false,
    });
    expect(prisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });

  it("preserves catalog-admin authority separately from an explicit grant", async () => {
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

    const result = await getCatalogCapability("missing-catalog", "host-1");

    expect(result).toMatchObject({
      catalogId: "missing-catalog",
      catalogExists: false,
      hasAccess: false,
      catalogGrant: null,
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
      role: "listener",
      extraPermissions: [],
      status: "ACTIVE",
    });

    const result = await getRecordingCapability("catalog-1", "hash-1", "listener-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      hasAccess: true,
      canAccessRecording: false,
      canStreamAudio: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: false,
      canUseRagSearch: false,
    });
  });

  it("allows hosts to resolve inactive catalog settings when explicitly requested", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockImplementation(({ where }: { where: { id: string; isActive?: boolean } }) =>
      Promise.resolve(where.isActive === undefined ? { id: "catalog-1" } : null)
    );
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "host",
      extraPermissions: [],
      status: "ACTIVE",
    });

    const result = await getCatalogCapability("catalog-1", "host-1", {
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

  it("denies reader recording capabilities when the catalog entry is missing", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "reader",
      extraPermissions: [],
      status: "ACTIVE",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const result = await getRecordingCapability("catalog-1", "hash-1", "reader-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      hasAccess: true,
      canAccessRecording: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: false,
    });
  });

  it("preserves edit capability for curators when the recording entry is missing", async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      role: "curator",
      extraPermissions: [],
      status: "ACTIVE",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const result = await getRecordingCapability("catalog-1", "hash-1", "curator-1");

    expect(result).toMatchObject({
      catalogId: "catalog-1",
      hash: "hash-1",
      hasAccess: true,
      canAccessRecording: false,
      canViewRecordingTranscripts: false,
      canDownloadRecording: false,
      canEditRecording: true,
    });
  });
});
