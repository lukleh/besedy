import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePortalAdmissionForUser,
  findPendingPortalAdmission,
} from "@/lib/admission/auth-claim";
import { ArchiveConfigurationError } from "@/lib/archive";

const ARCHIVE_ID = "20260101_000000";
const EMAIL = "username@gmail.com";
const mocks = vi.hoisted(() => ({ requireArchive: vi.fn() }));
vi.mock("@/lib/archive", async (original) => ({
  ...(await original<typeof import("@/lib/archive")>()),
  requireArchive: mocks.requireArchive,
}));
vi.mock("@/lib/db", () => ({ default: {} }));

const admission = {
  id: "portal-1",
  admittedById: "admin-1",
  admittedAt: new Date("2026-03-10T09:00:00Z"),
  notes: "invitation",
};
function database() {
  const tx = {
    portalAdmission: {
      findFirst: vi.fn().mockResolvedValue(admission),
      findUnique: vi.fn().mockResolvedValue(admission),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pendingCatalogGrant: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          catalogId: ARCHIVE_ID,
          role: "reader",
          extraPermissions: ["download_audio"],
          grantedById: "host-1",
          notes: "content access",
        }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    catalogAccess: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) =>
    callback(tx)
  );
  return { tx, db: { ...tx, $transaction: transaction }, transaction };
}
const user = { id: "user-1", email: " User.Name+tag@GoogleMail.com " };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireArchive.mockResolvedValue({ id: ARCHIVE_ID, label: "Archive" });
});

describe("bound invitation signup", () => {
  it.each(["PENDING", "REVOKED", "CONSUMED", null])(
    "requires both pending admission and bound pending grant before account creation: %s",
    async (status) => {
      const { tx, db } = database();
      tx.pendingCatalogGrant.findUnique.mockResolvedValue(
        status ? ({ status } as never) : null
      );
      const result = await findPendingPortalAdmission(user.email, db as never);
      expect(result).toEqual(status === "PENDING" ? admission : null);
      expect(tx.portalAdmission.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: EMAIL, status: "PENDING" } })
      );
      expect(tx.pendingCatalogGrant.findUnique).toHaveBeenCalledWith({
        where: { email_catalogId: { email: EMAIL, catalogId: ARCHIVE_ID } },
        select: { status: true },
      });
    }
  );

  it("does not admit a grant without a pending portal admission", async () => {
    const { tx, db } = database();
    tx.portalAdmission.findFirst.mockResolvedValue(null);
    tx.pendingCatalogGrant.findUnique.mockResolvedValue({
      status: "PENDING",
    } as never);
    expect(
      await findPendingPortalAdmission(user.email, db as never)
    ).toBeNull();
  });

  it("fails closed on missing/invalid/inactive archive configuration", async () => {
    const { db, transaction } = database();
    mocks.requireArchive.mockRejectedValue(
      new ArchiveConfigurationError("Unavailable archive")
    );
    await expect(
      findPendingPortalAdmission(user.email, db as never)
    ).rejects.toBeInstanceOf(ArchiveConfigurationError);
    await expect(
      consumePortalAdmissionForUser(user, db as never)
    ).rejects.toBeInstanceOf(ArchiveConfigurationError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns null without an email or an available admission", async () => {
    const { tx, db, transaction } = database();
    expect(
      await consumePortalAdmissionForUser({ id: user.id }, db as never)
    ).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    tx.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    expect(await consumePortalAdmissionForUser(user, db as never)).toBeNull();
    expect(tx.pendingCatalogGrant.findUnique).not.toHaveBeenCalled();
    expect(tx.catalogAccess.createMany).not.toHaveBeenCalled();
  });

  it.each([
    "listener",
    "reader",
    "corrector",
    "host",
    "curator",
    "catalog_admin",
  ])(
    "atomically claims only bound %s access, retaining extras and attribution",
    async (role) => {
      const { tx, db } = database();
      const grant = {
        catalogId: ARCHIVE_ID,
        role,
        extraPermissions: ["download_audio"],
        grantedById: "host-1",
        notes: "content access",
      };
      tx.pendingCatalogGrant.findUnique.mockResolvedValue(grant);
      const result = await consumePortalAdmissionForUser(user, db as never);
      expect(result).toEqual({
        portalAdmissionId: admission.id,
        admittedById: admission.admittedById,
        admittedAt: admission.admittedAt,
        notes: admission.notes,
        grants: [grant],
      });
      expect(tx.pendingCatalogGrant.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email_catalogId: { email: EMAIL, catalogId: ARCHIVE_ID },
            status: "PENDING",
          },
        })
      );
      expect(tx.pendingCatalogGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: EMAIL, catalogId: ARCHIVE_ID, status: "PENDING" },
        })
      );
      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: user.id, status: "PENDING" },
          data: expect.objectContaining({ status: "ACTIVE" }),
        })
      );
      expect(tx.catalogAccess.createMany).toHaveBeenCalledWith({
        data: [{ userId: user.id, ...grant }],
        skipDuplicates: true,
      });
      expect(
        tx.portalAdmission.updateMany.mock.invocationCallOrder[0]
      ).toBeLessThan(
        tx.pendingCatalogGrant.updateMany.mock.invocationCallOrder[0]
      );
    }
  );

  it.each([
    "missing bound grant",
    "revoked during claim",
    "blocked/nonpending user",
  ])("rejects and rolls the transaction back for %s", async (failure) => {
    const { tx, db } = database();
    if (failure === "missing bound grant")
      tx.pendingCatalogGrant.findUnique.mockResolvedValue(null);
    if (failure === "revoked during claim")
      tx.pendingCatalogGrant.updateMany.mockResolvedValue({ count: 0 });
    if (failure === "blocked/nonpending user")
      tx.user.updateMany.mockResolvedValue({ count: 0 });
    let rolledBack = false;
    db.$transaction.mockImplementation(async (callback) => {
      try {
        return await callback(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    expect(await consumePortalAdmissionForUser(user, db as never)).toBeNull();
    expect(rolledBack).toBe(true);
    expect(tx.catalogAccess.createMany).not.toHaveBeenCalled();
  });

  it("completes the claim when the bound access row already exists", async () => {
    const { tx, db } = database();
    tx.catalogAccess.createMany.mockResolvedValue({ count: 0 });
    expect(await consumePortalAdmissionForUser(user, db as never)).toMatchObject({
      portalAdmissionId: admission.id,
    });
  });

  it("does not swallow an unexpected database failure", async () => {
    const { tx, db } = database();
    tx.catalogAccess.createMany.mockRejectedValue(
      new Error("database unavailable")
    );
    await expect(
      consumePortalAdmissionForUser(user, db as never)
    ).rejects.toThrow("database unavailable");
  });
});
