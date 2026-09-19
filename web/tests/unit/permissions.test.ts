import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthError } from "@/lib/auth/permissions";
import { accessLevelAtLeast } from "@/lib/policy/access-level";

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
