import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortalAdmissionNotClaimedError,
  PortalAdmissionNotFoundError,
  PortalAdmissionUserStillExistsError,
  resetClaimedPortalAdmission,
} from "@/lib/admission/admin-reset";

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
  },
}));

describe("admission admin reset", () => {
  let prisma: { $transaction: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("resets claimed admission and consumed grants back to pending", async () => {
    const tx = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: "portal-1",
          email: "user@example.com",
          status: "CLAIMED",
          admittedById: "admin-1",
          admittedAt: new Date("2026-03-10T10:00:00.000Z"),
          notes: "allowlisted",
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            catalogId: "20260101_000000",
            accessLevel: "EDITOR",
            grantedById: "owner-1",
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            notes: "catalog grant",
          },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await resetClaimedPortalAdmission("user@example.com", "admin-2");

    expect(result).toEqual({
      portalAdmissionId: "portal-1",
      email: "user@example.com",
      pendingGrantCount: 1,
      reopenedGrants: [
        {
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
        },
      ],
    });
    expect(tx.portalAdmission.update).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
      data: {
        status: "PENDING",
        claimedById: null,
        claimedAt: null,
        revocationReason: null,
        revokedById: null,
        revokedAt: null,
      },
    });
    expect(tx.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: {
        email: "user@example.com",
        status: "CONSUMED",
      },
      data: {
        status: "PENDING",
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
      },
    });
  });

  it("does not reopen grants when none were consumed", async () => {
    const tx = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: "portal-1",
          email: "user@example.com",
          status: "CLAIMED",
          admittedById: null,
          admittedAt: new Date("2026-03-10T10:00:00.000Z"),
          notes: "allowlisted",
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await resetClaimedPortalAdmission("user@example.com", "admin-2");

    expect(result).toEqual({
      portalAdmissionId: "portal-1",
      email: "user@example.com",
      pendingGrantCount: 0,
      reopenedGrants: [],
    });
    expect(tx.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
  });

  it("rejects missing admissions", async () => {
    const tx = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1")
    ).rejects.toBeInstanceOf(PortalAdmissionNotFoundError);
  });

  it("rejects non-claimed admissions", async () => {
    const tx = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: "portal-1",
          email: "user@example.com",
          status: "PENDING",
        }),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1")
    ).rejects.toBeInstanceOf(PortalAdmissionNotClaimedError);
  });

  it("rejects resets while the claimed user still exists", async () => {
    const tx = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: "portal-1",
          email: "user@example.com",
          status: "CLAIMED",
          admittedById: "admin-1",
          admittedAt: new Date("2026-03-10T10:00:00.000Z"),
          notes: "allowlisted",
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "user-1",
        }),
      },
    };

    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1")
    ).rejects.toBeInstanceOf(PortalAdmissionUserStillExistsError);
  });
});
