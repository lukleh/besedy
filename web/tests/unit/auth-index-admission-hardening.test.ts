import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import {
  MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
} from "@/lib/mcp/config";

const mocks = vi.hoisted(() => ({
  capturedAuthOptions: null as unknown,
  betterAuth: vi.fn(),
  consumePortalAdmissionForUser: vi.fn(),
  findPendingPortalAdmission: vi.fn(),
  getSuperadminEmail: vi.fn(),
  canonicalizeEmail: vi.fn((email: string) => email.toLowerCase()),
  getAuthTrustedOrigins: vi.fn(() => []),
  getGoogleOAuthConfig: vi.fn(() => null),
  fetchCimdClientMetadataResource: vi.fn(),
  logLogin: vi.fn(),
  logPortalAdmissionEvent: vi.fn(),
  mcp: vi.fn(() => ({ id: "mcpPlugin" })),
  cimd: vi.fn(() => ({ id: "cimdPlugin" })),
  prisma: {
    user: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("better-auth", () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter: vi.fn(() => ({})),
}));

vi.mock("better-auth/next-js", () => ({
  nextCookies: vi.fn(() => ({ id: "nextCookiesPlugin" })),
}));

vi.mock("better-auth/plugins", () => ({
  genericOAuth: vi.fn(() => ({ id: "genericOAuthPlugin" })),
  jwt: vi.fn(() => ({ id: "jwtPlugin" })),
}));

vi.mock("@better-auth/mcp", () => ({
  mcp: mocks.mcp,
}));

vi.mock("@better-auth/cimd", () => ({
  cimd: mocks.cimd,
}));

vi.mock("@/lib/auth/cimd-fetch", () => ({
  fetchCimdClientMetadataResource: mocks.fetchCimdClientMetadataResource,
}));

vi.mock("better-auth/api", () => {
  class APIError extends Error {
    code: string;

    constructor(code: string, options?: { message?: string }) {
      super(options?.message ?? code);
      this.name = "APIError";
      this.code = code;
    }
  }

  return { APIError };
});

vi.mock("@/lib/db", () => ({
  default: mocks.prisma,
}));

vi.mock("@/lib/config", () => ({
  getSuperadminEmail: mocks.getSuperadminEmail,
}));

vi.mock("@/lib/email", () => ({
  canonicalizeEmail: mocks.canonicalizeEmail,
}));

vi.mock("@/lib/admission/auth-claim", () => ({
  consumePortalAdmissionForUser: mocks.consumePortalAdmissionForUser,
  findPendingPortalAdmission: mocks.findPendingPortalAdmission,
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthTrustedOrigins: mocks.getAuthTrustedOrigins,
}));

vi.mock("@/lib/audit/logger", () => ({
  logLogin: mocks.logLogin,
  logPortalAdmissionEvent: mocks.logPortalAdmissionEvent,
}));

vi.mock("@/lib/auth/provider-config", () => ({
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));

vi.mock("@/lib/auth/constants", () => ({
  AUTH_COOKIE_PREFIX: "besedy",
  SESSION_EXPIRES_IN_SECONDS: 60 * 60 * 24 * 30,
  SESSION_UPDATE_AGE_SECONDS: 60 * 60 * 24,
}));

type UserCreateAfterHook = (user: {
  id: string;
  email?: string | null;
}) => Promise<void>;

type UserCreateBeforeHook = (user: Record<string, unknown>) => Promise<void>;

function getUserCreateBeforeHook(): UserCreateBeforeHook {
  const authOptions = mocks.capturedAuthOptions as {
    databaseHooks?: {
      user?: {
        create?: {
          before?: UserCreateBeforeHook;
        };
      };
    };
  };

  const hook = authOptions.databaseHooks?.user?.create?.before;
  if (!hook) {
    throw new Error("Expected auth user.create.before hook to be configured");
  }

  return hook;
}

function getUserCreateAfterHook(): UserCreateAfterHook {
  const authOptions = mocks.capturedAuthOptions as {
    databaseHooks?: {
      user?: {
        create?: {
          after?: UserCreateAfterHook;
        };
      };
    };
  };

  const hook = authOptions.databaseHooks?.user?.create?.after;
  if (!hook) {
    throw new Error("Expected auth user.create.after hook to be configured");
  }

  return hook;
}

describe("auth admission hardening", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("BESEDY_MCP_TEST_ENABLED", "true");

    mocks.capturedAuthOptions = null;
    mocks.betterAuth.mockImplementation((options: unknown) => {
      mocks.capturedAuthOptions = options;
      return { handler: {} };
    });

    mocks.consumePortalAdmissionForUser.mockResolvedValue(null);
    mocks.findPendingPortalAdmission.mockResolvedValue(null);
    mocks.getSuperadminEmail.mockReturnValue(null);
    mocks.getGoogleOAuthConfig.mockReturnValue(null);
    mocks.getAuthTrustedOrigins.mockReturnValue([]);
    mocks.prisma.user.findUnique.mockResolvedValue({
      email: "invited@example.com",
      isSuperadmin: false,
    });
    mocks.prisma.user.delete.mockResolvedValue({ id: "user-1" });
    mocks.logLogin.mockResolvedValue(undefined);
    mocks.logPortalAdmissionEvent.mockResolvedValue(undefined);

    await import("@/lib/auth/index");
  });

  it("supports CIMD with a PKCE-protected DCR fallback for MCP clients", () => {
    expect(mocks.mcp).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
        refreshTokenExpiresIn: MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
        refreshTokenReuseInterval: MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
      }),
    );
    expect(mocks.cimd).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchClientMetadataResource: mocks.fetchCimdClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    );
  });

  it("uses portal admission checks before signup", async () => {
    mocks.findPendingPortalAdmission.mockResolvedValue({
      id: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T10:00:00.000Z"),
      notes: "allowlisted",
    });

    vi.resetModules();
    await import("@/lib/auth/index");
    const beforeHook = getUserCreateBeforeHook();
    const user = { email: "Invited@Example.com" };

    await expect(beforeHook(user)).resolves.toBeUndefined();

    expect(mocks.findPendingPortalAdmission).toHaveBeenCalledWith("invited@example.com");
    expect(user).toMatchObject({
      email: "invited@example.com",
      invitedById: "admin-1",
      invitedAt: new Date("2026-03-10T10:00:00.000Z"),
    });
  });

  it("uses portal admission claim when creating the user", async () => {
    mocks.consumePortalAdmissionForUser.mockResolvedValue({
      portalAdmissionId: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T10:00:00.000Z"),
      notes: "allowlisted",
      grants: [
        {
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
          grantedById: "owner-1",
          notes: "catalog grant",
        },
      ],
    });

    vi.resetModules();
    await import("@/lib/auth/index");
    const afterHook = getUserCreateAfterHook();

    await expect(
      afterHook({
        id: "user-1",
        email: "invited@example.com",
      })
    ).resolves.toBeUndefined();

    expect(mocks.consumePortalAdmissionForUser).toHaveBeenCalledWith({
      id: "user-1",
      email: "invited@example.com",
    });
    expect(mocks.logPortalAdmissionEvent).toHaveBeenCalledWith({
      actorId: "user-1",
      action: "PORTAL_ADMISSION_CLAIMED",
      resourceId: "portal-1",
      email: "invited@example.com",
      catalogId: "20260101_000000",
      details: expect.objectContaining({
        portalAdmissionId: "portal-1",
        pendingGrantCount: 1,
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
      }),
    });
  });

  it("rejects signup and rolls back user when portal admission claim misses", async () => {
    const afterHook = getUserCreateAfterHook();
    const run = afterHook({
      id: "user-1",
      email: "invited@example.com",
    });

    await expect(run).rejects.toBeInstanceOf(APIError);
    await expect(run).rejects.toMatchObject({
      message: "not_authorized:invited@example.com",
    });

    expect(mocks.consumePortalAdmissionForUser).toHaveBeenCalledWith({
      id: "user-1",
      email: "invited@example.com",
    });
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { email: true, isSuperadmin: true },
    });
    expect(mocks.prisma.user.delete).toHaveBeenCalledWith({
      where: { id: "user-1" },
    });
  });

  it("preserves superadmin bootstrap when invitation claim misses", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      email: "superadmin@example.com",
      isSuperadmin: true,
    });
    const afterHook = getUserCreateAfterHook();

    await expect(
      afterHook({
        id: "super-1",
        email: "superadmin@example.com",
      })
    ).resolves.toBeUndefined();

    expect(mocks.consumePortalAdmissionForUser).toHaveBeenCalledWith({
      id: "super-1",
      email: "superadmin@example.com",
    });
    expect(mocks.prisma.user.delete).not.toHaveBeenCalled();
  });
});
