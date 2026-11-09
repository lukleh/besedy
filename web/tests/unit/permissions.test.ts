import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthError } from "@/lib/auth/permissions";

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
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

beforeEach(async () => {
  vi.stubEnv("BESEDY_ARCHIVE_ID", "20251225_120000");
  const prisma = (await import("@/lib/db")).default;
  vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "20251225_120000", isActive: true } as never);
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

vi.mock("@/lib/auth/session", () => ({ getCurrentUserId: vi.fn() }));

describe('requireAuth', () => {
  it('rejects an absent session', async () => {
      const { getCurrentUserId } = await import("@/lib/auth/session");
    vi.mocked(getCurrentUserId).mockResolvedValue(null);

    const { requireAuth } = await import("@/lib/auth/permissions");
    await expect(requireAuth()).rejects.toMatchObject({
      name: "AuthError",
      statusCode: 401,
    });
  });

  it('returns the authenticated identity', async () => {
    const { getCurrentUserId } = await import('@/lib/auth/session');
    vi.mocked(getCurrentUserId).mockResolvedValue('user-id');

    const { requireAuth } = await import("@/lib/auth/permissions");
    await expect(requireAuth()).resolves.toBe('user-id');
  });
});
