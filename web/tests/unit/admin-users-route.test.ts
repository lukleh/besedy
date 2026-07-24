import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAdminUsers } from "@/app/api/admin/users/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findMany: vi.fn(),
    },
  },
}));

describe("admin users route", () => {
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    user: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("computes highestAccessLevel and catalogNames", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([
      {
        id: "user-1",
        name: "User One",
        email: "user1@example.com",
        image: null,
        status: "ACTIVE",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: new Date(),
        activatedAt: new Date(),
        catalogAccess: [
          { accessLevel: "VIEWER", catalog: { id: "cat-1", label: "Catalog A" } },
          { accessLevel: "OWNER", catalog: { id: "cat-2", label: null } },
        ],
      },
    ]);

    const request = new NextRequest("http://localhost/api/admin/users");
    const response = await getAdminUsers(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].highestAccessLevel).toBe("OWNER");
    expect(body[0].catalogNames).toEqual(["Catalog A", "cat-2"]);
    expect(body[0].catalogAccess).toBeUndefined();
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          catalogAccess: expect.objectContaining({
            where: { status: "ACTIVE" },
          }),
        }),
      })
    );
  });

  it("filters real users by requested status, including PENDING", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([
      {
        id: "user-2",
        name: "Pending User",
        email: "pending@example.com",
        image: null,
        status: "PENDING",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        activatedAt: null,
        catalogAccess: [],
      },
    ]);

    const request = new NextRequest(
      "http://localhost/api/admin/users?status=PENDING&search=pending"
    );
    const response = await getAdminUsers(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      {
        id: "user-2",
        name: "Pending User",
        email: "pending@example.com",
        image: null,
        status: "PENDING",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: "2026-03-10T10:00:00.000Z",
        activatedAt: null,
        type: "user",
        highestAccessLevel: null,
        catalogNames: [],
      },
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          OR: [
            { email: { contains: "pending", mode: "insensitive" } },
            { name: { contains: "pending", mode: "insensitive" } },
          ],
        },
      })
    );
  });

  it("passes a PENDING status through to the user query when no search param is given", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([]);

    const request = new NextRequest("http://localhost/api/admin/users?status=PENDING");
    const response = await getAdminUsers(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
        },
      })
    );
  });
});
