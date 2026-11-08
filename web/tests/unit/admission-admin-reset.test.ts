import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortalAdmissionNotClaimedError,
  PortalAdmissionNotFoundError,
  PortalAdmissionUserStillExistsError,
  PortalAdmissionMissingContentAccessError,
  resetClaimedPortalAdmission,
} from "@/lib/admission/admin-reset";
import { ArchiveConfigurationError } from "@/lib/archive";
const ID = "20260101_000000";
const mocks = vi.hoisted(() => ({ requireArchive: vi.fn() }));
vi.mock("@/lib/archive", async (original) => ({
  ...(await original<typeof import("@/lib/archive")>()),
  requireArchive: mocks.requireArchive,
}));
vi.mock("@/lib/db", () => ({ default: {} }));
function database() {
  const tx = {
    portalAdmission: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: "portal-1",
          email: "user@example.com",
          status: "CLAIMED",
        }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    pendingCatalogGrant: {
      findUnique: vi.fn().mockResolvedValue({ catalogId: ID, role: "curator" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  return { tx, db };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireArchive.mockResolvedValue({ id: ID });
});
describe("bound invitation reset", () => {
  it("reopens only the bound consumed grant, preserving foreign history and source roles", async () => {
    const { tx, db } = database();
    expect(
      await resetClaimedPortalAdmission(
        "User@Example.com",
        "admin-2",
        db as never
      )
    ).toEqual({
      portalAdmissionId: "portal-1",
      email: "user@example.com",
      pendingGrantCount: 1,
      reopenedGrants: [{ catalogId: ID, role: "curator" }],
    });
    expect(tx.pendingCatalogGrant.findUnique).toHaveBeenCalledWith({
      where: {
        email_catalogId: { email: "user@example.com", catalogId: ID },
        status: "CONSUMED",
      },
      select: { catalogId: true, role: true },
    });
    expect(tx.portalAdmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "user@example.com", status: "CLAIMED" },
        data: expect.objectContaining({
          status: "PENDING",
          claimedById: null,
          claimedAt: null,
        }),
      })
    );
    expect(tx.pendingCatalogGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "user@example.com", catalogId: ID, status: "CONSUMED" },
      })
    );
    expect(
      tx.portalAdmission.updateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(
      tx.pendingCatalogGrant.updateMany.mock.invocationCallOrder[0]
    );
  });
  it.each([
    ["missing", null, PortalAdmissionNotFoundError],
    ["pending", { status: "PENDING" }, PortalAdmissionNotClaimedError],
    ["revoked", { status: "REVOKED" }, PortalAdmissionNotClaimedError],
  ])(
    "rejects %s admission without changing any state",
    async (_name, admission, error) => {
      const { tx, db } = database();
      tx.portalAdmission.findUnique.mockResolvedValue(admission as never);
      await expect(
        resetClaimedPortalAdmission("user@example.com", "admin-1", db as never)
      ).rejects.toBeInstanceOf(error);
      expect(tx.portalAdmission.updateMany).not.toHaveBeenCalled();
      expect(tx.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
    }
  );
  it("rejects a claimed admission while its account still exists", async () => {
    const { tx, db } = database();
    tx.user.findUnique.mockResolvedValue({ id: "existing-user" } as never);
    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1", db as never)
    ).rejects.toBeInstanceOf(PortalAdmissionUserStillExistsError);
    expect(tx.portalAdmission.updateMany).not.toHaveBeenCalled();
  });
  it("rejects legacy standalone or foreign-only saved grants", async () => {
    const { tx, db } = database();
    tx.pendingCatalogGrant.findUnique.mockResolvedValue(null);
    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1", db as never)
    ).rejects.toBeInstanceOf(PortalAdmissionMissingContentAccessError);
    expect(tx.portalAdmission.updateMany).not.toHaveBeenCalled();
  });
  it.each(["admission", "grant"])(
    "rolls back if a competing reset changes the %s",
    async (changed) => {
      const { tx, db } = database();
      if (changed === "admission")
        tx.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
      else tx.pendingCatalogGrant.updateMany.mockResolvedValue({ count: 0 });
      let rolledBack = false;
      db.$transaction.mockImplementation(async (callback) => {
        try {
          return await callback(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      });
      await expect(
        resetClaimedPortalAdmission("user@example.com", "admin-1", db as never)
      ).rejects.toThrow();
      expect(rolledBack).toBe(true);
    }
  );
  it("requires a configured active archive before reopening anything", async () => {
    const { db } = database();
    mocks.requireArchive.mockRejectedValue(
      new ArchiveConfigurationError("Archive unavailable")
    );
    await expect(
      resetClaimedPortalAdmission("user@example.com", "admin-1", db as never)
    ).rejects.toBeInstanceOf(ArchiveConfigurationError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
