import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Permission,
  AuthError,
  accessLevelAtLeast,
  getPermissionsForAccessLevel,
} from "@/lib/auth/permissions";

// Mock prisma for database-dependent tests
vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    catalogAccess: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    workflowGroup: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe("Permission constants", () => {
  it("should have all expected permission types", () => {
    expect(Permission.SUPERADMIN).toBe("SUPERADMIN");
    expect(Permission.MANAGE_USERS).toBe("MANAGE_USERS");
    expect(Permission.MANAGE_CATALOGS).toBe("MANAGE_CATALOGS");
    expect(Permission.VIEW).toBe("VIEW");
    expect(Permission.STREAM).toBe("STREAM");
    expect(Permission.VIEW_TRANSCRIPTS).toBe("VIEW_TRANSCRIPTS");
    expect(Permission.COMMENT).toBe("COMMENT");
    expect(Permission.DOWNLOAD).toBe("DOWNLOAD");
    expect(Permission.EDIT_METADATA).toBe("EDIT_METADATA");
    expect(Permission.MANAGE_ACCESS).toBe("MANAGE_ACCESS");
    expect(Permission.MANAGE_PENDING_ACCESS).toBe("MANAGE_PENDING_ACCESS");
  });

  it("should have 11 permission types", () => {
    expect(Object.keys(Permission)).toHaveLength(11);
  });
});

describe("accessLevelAtLeast", () => {
  it("should correctly compare access levels", () => {
    // LISTENER is the lowest level
    expect(accessLevelAtLeast("LISTENER", "LISTENER")).toBe(true);
    expect(accessLevelAtLeast("VIEWER", "LISTENER")).toBe(true);
    expect(accessLevelAtLeast("MEMBER", "LISTENER")).toBe(true);
    expect(accessLevelAtLeast("EDITOR", "LISTENER")).toBe(true);
    expect(accessLevelAtLeast("OWNER", "LISTENER")).toBe(true);

    expect(accessLevelAtLeast("LISTENER", "VIEWER")).toBe(false);
    expect(accessLevelAtLeast("VIEWER", "VIEWER")).toBe(true);
    expect(accessLevelAtLeast("MEMBER", "VIEWER")).toBe(true);
    expect(accessLevelAtLeast("EDITOR", "VIEWER")).toBe(true);
    expect(accessLevelAtLeast("OWNER", "VIEWER")).toBe(true);

    expect(accessLevelAtLeast("LISTENER", "MEMBER")).toBe(false);
    expect(accessLevelAtLeast("VIEWER", "MEMBER")).toBe(false);
    expect(accessLevelAtLeast("MEMBER", "MEMBER")).toBe(true);
    expect(accessLevelAtLeast("EDITOR", "MEMBER")).toBe(true);
    expect(accessLevelAtLeast("OWNER", "MEMBER")).toBe(true);

    expect(accessLevelAtLeast("LISTENER", "EDITOR")).toBe(false);
    expect(accessLevelAtLeast("VIEWER", "EDITOR")).toBe(false);
    expect(accessLevelAtLeast("MEMBER", "EDITOR")).toBe(false);
    expect(accessLevelAtLeast("EDITOR", "EDITOR")).toBe(true);
    expect(accessLevelAtLeast("OWNER", "EDITOR")).toBe(true);

    expect(accessLevelAtLeast("LISTENER", "OWNER")).toBe(false);
    expect(accessLevelAtLeast("VIEWER", "OWNER")).toBe(false);
    expect(accessLevelAtLeast("MEMBER", "OWNER")).toBe(false);
    expect(accessLevelAtLeast("EDITOR", "OWNER")).toBe(false);
    expect(accessLevelAtLeast("OWNER", "OWNER")).toBe(true);
  });
});

describe("getPermissionsForAccessLevel", () => {
  it("should return correct permissions for LISTENER", () => {
    const permissions = getPermissionsForAccessLevel("LISTENER");
    expect(permissions.has(Permission.VIEW)).toBe(true);
    expect(permissions.has(Permission.STREAM)).toBe(true);
    // LISTENER should NOT have these (especially VIEW_TRANSCRIPTS)
    expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(false);
    expect(permissions.has(Permission.COMMENT)).toBe(false);
    expect(permissions.has(Permission.DOWNLOAD)).toBe(false);
    expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    expect(permissions.has(Permission.MANAGE_PENDING_ACCESS)).toBe(false);
  });

  it("should return correct permissions for VIEWER", () => {
    const permissions = getPermissionsForAccessLevel("VIEWER");
    expect(permissions.has(Permission.VIEW)).toBe(true);
    expect(permissions.has(Permission.STREAM)).toBe(true);
    expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    // VIEWER should NOT have these
    expect(permissions.has(Permission.COMMENT)).toBe(false);
    expect(permissions.has(Permission.DOWNLOAD)).toBe(false);
    expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    expect(permissions.has(Permission.MANAGE_PENDING_ACCESS)).toBe(false);
  });

  it("should return correct permissions for MEMBER", () => {
    const permissions = getPermissionsForAccessLevel("MEMBER");
    expect(permissions.has(Permission.VIEW)).toBe(true);
    expect(permissions.has(Permission.STREAM)).toBe(true);
    expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    expect(permissions.has(Permission.COMMENT)).toBe(true);
    expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    // MEMBER should NOT have these
    expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    expect(permissions.has(Permission.MANAGE_PENDING_ACCESS)).toBe(false);
  });

  it("should return correct permissions for EDITOR", () => {
    const permissions = getPermissionsForAccessLevel("EDITOR");
    expect(permissions.has(Permission.VIEW)).toBe(true);
    expect(permissions.has(Permission.STREAM)).toBe(true);
    expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    expect(permissions.has(Permission.COMMENT)).toBe(true);
    expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    expect(permissions.has(Permission.EDIT_METADATA)).toBe(true);
    // EDITOR should NOT have these
    expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    expect(permissions.has(Permission.MANAGE_PENDING_ACCESS)).toBe(false);
  });

  it("should return correct permissions for OWNER", () => {
    const permissions = getPermissionsForAccessLevel("OWNER");
    expect(permissions.has(Permission.VIEW)).toBe(true);
    expect(permissions.has(Permission.STREAM)).toBe(true);
    expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    expect(permissions.has(Permission.COMMENT)).toBe(true);
    expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    expect(permissions.has(Permission.EDIT_METADATA)).toBe(true);
    expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(true);
    expect(permissions.has(Permission.MANAGE_PENDING_ACCESS)).toBe(true);
  });
});

describe("Permission matrix - feature access by role", () => {
  // This tests the permission matrix that determines who can do what
  // These tests replace the need for exhaustive E2E role testing

  describe("VIEW_TRANSCRIPTS permission", () => {
    it("LISTENER cannot view transcripts", () => {
      const permissions = getPermissionsForAccessLevel("LISTENER");
      expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(false);
    });

    it("VIEWER can view transcripts", () => {
      const permissions = getPermissionsForAccessLevel("VIEWER");
      expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    });

    it("MEMBER can view transcripts", () => {
      const permissions = getPermissionsForAccessLevel("MEMBER");
      expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    });

    it("EDITOR can view transcripts", () => {
      const permissions = getPermissionsForAccessLevel("EDITOR");
      expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    });

    it("OWNER can view transcripts", () => {
      const permissions = getPermissionsForAccessLevel("OWNER");
      expect(permissions.has(Permission.VIEW_TRANSCRIPTS)).toBe(true);
    });
  });

  describe("DOWNLOAD permission", () => {
    it("LISTENER cannot download", () => {
      const permissions = getPermissionsForAccessLevel("LISTENER");
      expect(permissions.has(Permission.DOWNLOAD)).toBe(false);
    });

    it("VIEWER cannot download", () => {
      const permissions = getPermissionsForAccessLevel("VIEWER");
      expect(permissions.has(Permission.DOWNLOAD)).toBe(false);
    });

    it("MEMBER can download", () => {
      const permissions = getPermissionsForAccessLevel("MEMBER");
      expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    });

    it("EDITOR can download", () => {
      const permissions = getPermissionsForAccessLevel("EDITOR");
      expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    });

    it("OWNER can download", () => {
      const permissions = getPermissionsForAccessLevel("OWNER");
      expect(permissions.has(Permission.DOWNLOAD)).toBe(true);
    });
  });

  describe("EDIT_METADATA permission", () => {
    it("LISTENER cannot edit metadata", () => {
      const permissions = getPermissionsForAccessLevel("LISTENER");
      expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    });

    it("VIEWER cannot edit metadata", () => {
      const permissions = getPermissionsForAccessLevel("VIEWER");
      expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    });

    it("MEMBER cannot edit metadata", () => {
      const permissions = getPermissionsForAccessLevel("MEMBER");
      expect(permissions.has(Permission.EDIT_METADATA)).toBe(false);
    });

    it("EDITOR can edit metadata", () => {
      const permissions = getPermissionsForAccessLevel("EDITOR");
      expect(permissions.has(Permission.EDIT_METADATA)).toBe(true);
    });

    it("OWNER can edit metadata", () => {
      const permissions = getPermissionsForAccessLevel("OWNER");
      expect(permissions.has(Permission.EDIT_METADATA)).toBe(true);
    });
  });

  describe("MANAGE_ACCESS permission", () => {
    it("LISTENER cannot manage access", () => {
      const permissions = getPermissionsForAccessLevel("LISTENER");
      expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    });

    it("VIEWER cannot manage access", () => {
      const permissions = getPermissionsForAccessLevel("VIEWER");
      expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    });

    it("MEMBER cannot manage access", () => {
      const permissions = getPermissionsForAccessLevel("MEMBER");
      expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    });

    it("EDITOR cannot manage access", () => {
      const permissions = getPermissionsForAccessLevel("EDITOR");
      expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(false);
    });

    it("OWNER can manage access", () => {
      const permissions = getPermissionsForAccessLevel("OWNER");
      expect(permissions.has(Permission.MANAGE_ACCESS)).toBe(true);
    });
  });

  describe("VIEW and STREAM permissions (all roles)", () => {
    const allLevels = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"] as const;

    for (const level of allLevels) {
      it(`${level} can view`, () => {
        const permissions = getPermissionsForAccessLevel(level);
        expect(permissions.has(Permission.VIEW)).toBe(true);
      });

      it(`${level} can stream`, () => {
        const permissions = getPermissionsForAccessLevel(level);
        expect(permissions.has(Permission.STREAM)).toBe(true);
      });
    }
  });
});

describe("AuthError", () => {
  it("should create error with default status code 403", () => {
    const error = new AuthError("Access denied");
    expect(error.message).toBe("Access denied");
    expect(error.statusCode).toBe(403);
    expect(error.name).toBe("AuthError");
  });

  it("should create error with custom status code", () => {
    const error = new AuthError("Not authenticated", 401);
    expect(error.message).toBe("Not authenticated");
    expect(error.statusCode).toBe(401);
  });

  it("should be an instance of Error", () => {
    const error = new AuthError("Test error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthError);
  });
});

// Mock getSession for canAccessAdmin tests
vi.mock("@/lib/auth/session", () => {
  const getSession = vi.fn();
  return {
    getSession,
    getCurrentUserId: vi.fn(async () => {
      const session = await getSession();
      return session?.user?.id ?? null;
    }),
  };
});

describe("canAccessAdmin", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findUnique: ReturnType<typeof vi.fn> };
  };
  let mockGetSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    const authModule = await import("@/lib/auth/session");
    mockGetSession = authModule.getSession as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  it("should return false when no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const { canAccessAdmin } = await import("@/lib/auth/permissions");
    const result = await canAccessAdmin();

    expect(result).toBe(false);
  });

  it("should return true for superadmin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: true,
      isAdmin: false,
      status: "ACTIVE",
    });

    const { canAccessAdmin } = await import("@/lib/auth/permissions");
    const result = await canAccessAdmin();

    expect(result).toBe(true);
  });

  it("should return true for admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });

    const { canAccessAdmin } = await import("@/lib/auth/permissions");
    const result = await canAccessAdmin();

    expect(result).toBe(true);
  });

  it("should return false for regular active user (no first-user fallback)", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });

    const { canAccessAdmin } = await import("@/lib/auth/permissions");
    const result = await canAccessAdmin();

    expect(result).toBe(false);
  });

  it("should return false for blocked user even if admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "BLOCKED",
    });

    const { canAccessAdmin } = await import("@/lib/auth/permissions");
    const result = await canAccessAdmin();

    expect(result).toBe(false);
  });
});

describe("hasEditorOnAnyCatalog", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    vi.clearAllMocks();
  });

  it("returns false when only REVOKED editor/owner rows exist", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findFirst.mockResolvedValue(null);

    const { hasEditorOnAnyCatalog } = await import("@/lib/auth/permissions");
    const result = await hasEditorOnAnyCatalog("user-id");

    expect(result).toBe(false);
    expect(mockPrisma.catalogAccess.findFirst).toHaveBeenCalledWith({
      select: { userId: true },
      where: {
        userId: "user-id",
        status: "ACTIVE",
        accessLevel: { in: ["EDITOR", "OWNER"] },
      },
    });
  });

  it("returns true when user has ACTIVE editor access", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findFirst.mockResolvedValue({
      id: "access-1",
      accessLevel: "EDITOR",
      status: "ACTIVE",
    });

    const { hasEditorOnAnyCatalog } = await import("@/lib/auth/permissions");
    const result = await hasEditorOnAnyCatalog("user-id");

    expect(result).toBe(true);
  });

  it("returns true for admins without querying catalogAccess", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });

    const { hasEditorOnAnyCatalog } = await import("@/lib/auth/permissions");
    const result = await hasEditorOnAnyCatalog("admin-id");

    expect(result).toBe(true);
    expect(mockPrisma.catalogAccess.findFirst).not.toHaveBeenCalled();
  });
});

describe("getCatalogAccess", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findUnique: ReturnType<typeof vi.fn> };
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    vi.clearAllMocks();
    mockPrisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-id" });
  });

  it("returns null for non-active user even if access exists", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "BLOCKED",
    });

    const { getCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getCatalogAccess("user-id", "catalog-id");

    expect(result).toBeNull();
    expect(mockPrisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it("returns OWNER for admins without checking catalog access", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });

    const { getCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getCatalogAccess("admin-id", "catalog-id");

    expect(result).toBe("OWNER");
    expect(mockPrisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it("returns catalog access level for regular users with ACTIVE access", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "ACTIVE",
    });

    const { getCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getCatalogAccess("user-id", "catalog-id");

    expect(result).toBe("VIEWER");
  });

  it("returns null when catalog access status is REVOKED", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    // User has access record but it's been revoked
    mockPrisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "EDITOR",
      status: "REVOKED",
    });

    const { getCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getCatalogAccess("user-id", "catalog-id");

    expect(result).toBeNull();
  });

  it("returns null when no catalog access exists", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findUnique.mockResolvedValue(null);

    const { getCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getCatalogAccess("user-id", "catalog-id");

    expect(result).toBeNull();
  });
});

describe("getUserCatalogAccess", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findMany: ReturnType<typeof vi.fn> };
    workflowGroup: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    vi.clearAllMocks();
  });

  it("returns empty list for non-active user", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "PENDING",
    });

    const { getUserCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getUserCatalogAccess("user-id");

    expect(result).toEqual([]);
    expect(mockPrisma.catalogAccess.findMany).not.toHaveBeenCalled();
  });

  it("returns OWNER access for all active catalogs when admin", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });
    mockPrisma.workflowGroup.findMany.mockResolvedValue([
      { id: "catalog-1" },
      { id: "catalog-2" },
    ]);

    const { getUserCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getUserCatalogAccess("admin-id");

    expect(result).toEqual([
      { catalogId: "catalog-1", accessLevel: "OWNER" },
      { catalogId: "catalog-2", accessLevel: "OWNER" },
    ]);
  });

  it("returns user-specific catalog access for non-admin", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findMany.mockResolvedValue([
      { catalogId: "catalog-1", accessLevel: "VIEWER" },
      { catalogId: "catalog-2", accessLevel: "EDITOR" },
    ]);

    const { getUserCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await getUserCatalogAccess("user-id");

    expect(result).toEqual([
      { catalogId: "catalog-1", accessLevel: "VIEWER" },
      { catalogId: "catalog-2", accessLevel: "EDITOR" },
    ]);
  });

  it("only queries ACTIVE access records (filters out REVOKED)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findMany.mockResolvedValue([
      { catalogId: "catalog-1", accessLevel: "VIEWER" },
    ]);

    const { getUserCatalogAccess } = await import("@/lib/auth/permissions");
    await getUserCatalogAccess("user-id");

    // Verify the query includes status: "ACTIVE" filter
    expect(mockPrisma.catalogAccess.findMany).toHaveBeenCalledWith({
      where: { userId: "user-id", status: "ACTIVE" },
      select: {
        catalogId: true,
        accessLevel: true,
      },
    });
  });
});

describe("hasPermission", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  };
  let mockGetSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    const authModule = await import("@/lib/auth/session");
    mockGetSession = authModule.getSession as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  it("returns true for MANAGE_USERS when user is admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "admin-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });

    const { hasPermission } = await import("@/lib/auth/permissions");
    const result = await hasPermission(Permission.MANAGE_USERS);

    expect(result).toBe(true);
  });

  it("checks any-catalog permissions when catalogId is omitted", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findMany.mockResolvedValue([
      { catalogId: "catalog-1", accessLevel: "VIEWER" },
    ]);

    const { hasPermission } = await import("@/lib/auth/permissions");
    const canView = await hasPermission(Permission.VIEW_TRANSCRIPTS);
    const canEdit = await hasPermission(Permission.EDIT_METADATA);

    expect(canView).toBe(true);
    expect(canEdit).toBe(false);
  });

  it("returns false for catalog permission when access is missing", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findUnique.mockResolvedValue(null);

    const { hasPermission } = await import("@/lib/auth/permissions");
    const result = await hasPermission(Permission.DOWNLOAD, "catalog-1");

    expect(result).toBe(false);
  });
});

describe("requireCatalogAccess", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findUnique: ReturnType<typeof vi.fn> };
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
  };
  let mockGetSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    const authModule = await import("@/lib/auth/session");
    mockGetSession = authModule.getSession as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
    mockPrisma.workflowGroup.findFirst.mockResolvedValue({ id: "catalog-1" });
  });

  it("throws AuthError when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const { requireCatalogAccess } = await import("@/lib/auth/permissions");
    // Use toMatchObject instead of toBeInstanceOf because vi.resetModules() causes class identity mismatch
    await expect(requireCatalogAccess("catalog-1")).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 401,
    });
  });

  it("throws AuthError when user lacks required access", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "LISTENER",
      status: "ACTIVE",
    });

    const { requireCatalogAccess } = await import("@/lib/auth/permissions");
    // Use toMatchObject instead of toBeInstanceOf because vi.resetModules() causes class identity mismatch
    await expect(requireCatalogAccess("catalog-1", "VIEWER")).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 403,
    });
  });

  it("returns user id when access is sufficient", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    mockPrisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "EDITOR",
      status: "ACTIVE",
    });

    const { requireCatalogAccess } = await import("@/lib/auth/permissions");
    const result = await requireCatalogAccess("catalog-1", "VIEWER");

    expect(result).toBe("user-id");
  });

  it("throws AuthError when access is REVOKED", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });
    // User has EDITOR access but it's been revoked
    mockPrisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "EDITOR",
      status: "REVOKED",
    });

    const { requireCatalogAccess } = await import("@/lib/auth/permissions");
    await expect(requireCatalogAccess("catalog-1", "VIEWER")).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 403,
    });
  });
});

describe("requirePortalAdmissionManagement", () => {
  let mockPrisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
  };
  let mockGetSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const prismaModule = await import("@/lib/db");
    mockPrisma = prismaModule.default as unknown as typeof mockPrisma;
    const authModule = await import("@/lib/auth/session");
    mockGetSession = authModule.getSession as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  it("throws AuthError when user is not admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: false,
      status: "ACTIVE",
    });

    const { requirePortalAdmissionManagement } = await import("@/lib/auth/permissions");
    // Use toMatchObject instead of toBeInstanceOf because vi.resetModules() causes class identity mismatch
    await expect(requirePortalAdmissionManagement()).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 403,
    });
  });

  it("returns user id for admin users", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "admin-id" } });
    mockPrisma.user.findUnique.mockResolvedValue({
      isSuperadmin: false,
      isAdmin: true,
      status: "ACTIVE",
    });

    const { requirePortalAdmissionManagement } = await import("@/lib/auth/permissions");
    const result = await requirePortalAdmissionManagement();

    expect(result).toBe("admin-id");
  });
});
