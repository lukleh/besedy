import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePortalAdmissionForUser,
  findPendingPortalAdmission,
} from "@/lib/admission/auth-claim";

vi.mock("@/lib/db", () => ({
  default: {
    portalAdmission: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

describe("admission auth claim", () => {
  let prisma: {
    portalAdmission: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("looks up claimable portal admission by canonical email", async () => {
    prisma.portalAdmission.findFirst.mockResolvedValue({
      id: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T10:00:00.000Z"),
      notes: "allowlisted",
    });

    const result = await findPendingPortalAdmission(" User.Name+tag@GoogleMail.com ");

    expect(prisma.portalAdmission.findFirst).toHaveBeenCalledWith({
      where: {
        email: "username@gmail.com",
        status: "PENDING",
      },
      select: {
        id: true,
        admittedById: true,
        admittedAt: true,
        notes: true,
      },
    });
    expect(result).toEqual({
      id: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T10:00:00.000Z"),
      notes: "allowlisted",
    });
  });

  it("returns null when user email is missing", async () => {
    const result = await consumePortalAdmissionForUser({ id: "user-1", email: null });

    expect(result).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns null when portal admission is not claimable", async () => {
    const tx = {
      portalAdmission: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
      pendingCatalogGrant: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        updateMany: vi.fn(),
      },
      catalogAccess: {
        createMany: vi.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await consumePortalAdmissionForUser({
      id: "user-1",
      email: "user@example.com",
    });

    expect(result).toBeNull();
    expect(tx.portalAdmission.updateMany).toHaveBeenCalledWith({
      where: {
        email: "user@example.com",
        status: "PENDING",
      },
      data: expect.objectContaining({
        status: "CLAIMED",
        claimedById: "user-1",
      }),
    });
    expect(tx.portalAdmission.findUnique).not.toHaveBeenCalled();
    expect(tx.pendingCatalogGrant.findMany).not.toHaveBeenCalled();
  });

  it("claims portal admission, consumes pending grants, and activates the user", async () => {
    const admission = {
      id: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T09:00:00.000Z"),
      notes: "allowlisted",
    };
    const pendingGrant = {
      catalogId: "20260101_000000",
      accessLevel: "EDITOR",
      grantedById: "owner-1",
      notes: "catalog grant",
    };
    const tx = {
      portalAdmission: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(admission),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([pendingGrant]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      catalogAccess: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await consumePortalAdmissionForUser({
      id: "user-1",
      email: "user@example.com",
    });

    expect(result).toEqual({
      portalAdmissionId: "portal-1",
      admittedById: "admin-1",
      admittedAt: new Date("2026-03-10T09:00:00.000Z"),
      notes: "allowlisted",
      grants: [pendingGrant],
    });
    expect(tx.pendingCatalogGrant.findMany).toHaveBeenCalledWith({
      where: {
        email: "user@example.com",
        status: "PENDING",
      },
      select: {
        catalogId: true,
        accessLevel: true,
        grantedById: true,
        notes: true,
      },
      orderBy: [{ grantedAt: "asc" }, { catalogId: "asc" }],
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: "user-1",
        status: "PENDING",
      },
      data: expect.objectContaining({
        status: "ACTIVE",
      }),
    });
    expect(tx.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: {
        email: "user@example.com",
        status: "PENDING",
      },
      data: expect.objectContaining({
        status: "CONSUMED",
        consumedById: "user-1",
      }),
    });
    expect(tx.catalogAccess.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
          grantedById: "owner-1",
          notes: "catalog grant",
        },
      ],
      skipDuplicates: true,
    });
  });
});
