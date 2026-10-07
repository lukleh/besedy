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
    $queryRaw: vi.fn(),
  },
}));

describe("admin users route", () => {
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    user: {
      findMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    getAdminCapability = accessModule.getAdminCapability as ReturnType<
      typeof vi.fn
    >;
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it("adds last played and last activity times from the activity query", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([
      {
        id: "user-1",
        name: "Listener",
        email: "listener@example.com",
        image: null,
        status: "ACTIVE",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: new Date("2026-05-01T08:00:00.000Z"),
        createdAt: new Date("2026-04-01T08:00:00.000Z"),
        activatedAt: null,
        catalogAccess: [],
      },
      {
        id: "user-2",
        name: "Idle",
        email: "idle@example.com",
        image: null,
        status: "ACTIVE",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: new Date("2026-04-01T08:00:00.000Z"),
        activatedAt: null,
        catalogAccess: [],
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      {
        id: "user-1",
        last_played_at: new Date("2026-10-01T18:30:00.000Z"),
        last_activity_at: new Date("2026-10-02T09:15:00.000Z"),
      },
      { id: "user-2", last_played_at: null, last_activity_at: null },
    ]);

    const response = await getAdminUsers(
      new NextRequest("http://localhost/api/admin/users?include=activity")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0]).toMatchObject({
      id: "user-1",
      lastPlayedAt: "2026-10-01T18:30:00.000Z",
      lastActivityAt: "2026-10-02T09:15:00.000Z",
    });
    expect(body[1]).toMatchObject({
      id: "user-2",
      lastPlayedAt: null,
      lastActivityAt: null,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0]).toContainEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("counts audited streams and downloads toward last played", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([
      {
        id: "user-1",
        name: "Listener",
        email: "listener@example.com",
        image: null,
        status: "ACTIVE",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: new Date("2026-04-01T08:00:00.000Z"),
        activatedAt: null,
        catalogAccess: [],
      },
    ]);

    await getAdminUsers(
      new NextRequest("http://localhost/api/admin/users?include=activity")
    );

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (strings as string[]).join("?").replace(/\s+/g, " ");
    expect(sql).toContain(
      "GREATEST(s.last_progress_at, s.last_audio_at) AS last_played_at"
    );
    expect(sql).toMatch(
      /a\.action IN \( \?::"AuditAction", \?::"AuditAction" \)\) AS last_audio_at/
    );
    expect(values).toEqual(
      expect.arrayContaining(["AUDIO_STREAMED", "AUDIO_DOWNLOADED"])
    );
  });

  it("skips the activity query when no users match", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([]);

    const response = await getAdminUsers(
      new NextRequest(
        "http://localhost/api/admin/users?search=nobody&include=activity"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("leaves activity out unless it is requested", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findMany.mockResolvedValue([
      {
        id: "user-1",
        name: "Listener",
        email: "listener@example.com",
        image: null,
        status: "ACTIVE",
        isSuperadmin: false,
        isAdmin: false,
        lastLoginAt: null,
        createdAt: new Date("2026-04-01T08:00:00.000Z"),
        activatedAt: null,
        catalogAccess: [],
      },
    ]);

    const response = await getAdminUsers(
      new NextRequest("http://localhost/api/admin/users")
    );

    const [user] = await response.json();
    expect(user).not.toHaveProperty("lastPlayedAt");
    expect(user).not.toHaveProperty("lastActivityAt");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects an unknown include value", async () => {
    requireAuth.mockResolvedValue("admin-1");

    const response = await getAdminUsers(
      new NextRequest("http://localhost/api/admin/users?include=everything")
    );

    expect(response.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("returns unordered catalog roles and catalog names", async () => {
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
          {
            role: "reader",
            catalog: { id: "cat-1", label: "Catalog A" },
          },
          { role: "host", catalog: { id: "cat-2", label: null } },
        ],
      },
    ]);

    const request = new NextRequest("http://localhost/api/admin/users");
    const response = await getAdminUsers(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].catalogRoles).toEqual(["reader", "host"]);
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
        catalogRoles: [],
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

    const request = new NextRequest(
      "http://localhost/api/admin/users?status=PENDING"
    );
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
