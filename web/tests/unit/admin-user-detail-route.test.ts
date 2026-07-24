import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAdminUserDetail } from "@/app/api/admin/users/[id]/route";

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
      findUnique: vi.fn(),
    },
    portalAdmission: {
      findUnique: vi.fn(),
    },
  },
}));

describe("admin user detail route", () => {
  const USER_ID = "user12345678901234567";
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    portalAdmission: { findUnique: ReturnType<typeof vi.fn> };
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

  it("loads only active catalog grants in the user detail view", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "user@example.com",
      catalogAccess: [],
    });

    const request = new NextRequest(`http://localhost/api/admin/users/${USER_ID}`);
    const response = await getAdminUserDetail(request, {
      params: Promise.resolve({ id: USER_ID }),
    });

    expect(response.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          catalogAccess: expect.objectContaining({
            where: { status: "ACTIVE" },
          }),
        }),
      })
    );
  });

  it("uses portal admission provenance when an admission exists", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "user@example.com",
      invitedAt: new Date("2026-03-09T09:00:00.000Z"),
      invitedBy: {
        id: "legacy-admin",
        name: "Legacy Admin",
        email: "legacy@example.com",
      },
      catalogAccess: [],
    });
    prisma.portalAdmission.findUnique.mockResolvedValue({
      admittedAt: new Date("2026-03-10T10:00:00.000Z"),
      admittedBy: {
        id: "portal-admin",
        name: "Portal Admin",
        email: "portal@example.com",
      },
    });

    const response = await getAdminUserDetail(
      new NextRequest(`http://localhost/api/admin/users/${USER_ID}`),
      { params: Promise.resolve({ id: USER_ID }) }
    );

    expect(response.status).toBe(200);
    expect(prisma.portalAdmission.findUnique).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
      select: {
        admittedAt: true,
        admittedBy: {
          select: { id: true, name: true, email: true },
        },
      },
    });
    expect(await response.json()).toMatchObject({
      id: USER_ID,
      invitedBy: {
        id: "portal-admin",
        name: "Portal Admin",
        email: "portal@example.com",
      },
      invitedAt: "2026-03-10T10:00:00.000Z",
    });
  });
});
