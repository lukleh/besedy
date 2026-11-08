import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminDeniedAdmissionReopenError,
  PendingAdmissionUnavailableError,
  revokePendingAdmissionState,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";
import { ArchiveConfigurationError, ArchiveScopeError } from "@/lib/archive";
const ID = "20260101_000000";
const mocks = vi.hoisted(() => ({ requireArchive: vi.fn() }));
vi.mock("@/lib/archive", async (original) => ({
  ...(await original<typeof import("@/lib/archive")>()),
  requireArchive: mocks.requireArchive,
}));
vi.mock("@/lib/db", () => ({ default: {} }));
const input = {
  email: "John.Doe+tag@googlemail.com",
  catalogId: ID,
  role: "reader" as const,
  extraPermissions: ["download_audio"],
  createdById: "host-1",
  createdAt: new Date("2026-03-10T10:00:00Z"),
  notes: "invite",
};
function database(
  status: "PENDING" | "CLAIMED" | "REVOKED" | null = "PENDING",
  revocationReason: string | null = null
) {
  return {
    portalAdmission: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          status ? { status, revocationReason, source: "STANDALONE" } : null
        ),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pendingCatalogGrant: {
      upsert: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireArchive.mockResolvedValue({ id: ID });
});
describe("single bound invitation lifecycle", () => {
  it("creates one grant-backed admission with canonical email and exact role/extras", async () => {
    const db = database(null);
    await syncPendingAdmissionState(input, {}, db as never);
    expect(db.portalAdmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "johndoe@gmail.com",
        source: "PENDING_GRANT",
        status: "PENDING",
        admittedById: "host-1",
      }),
    });
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email_catalogId: { email: "johndoe@gmail.com", catalogId: ID },
        },
        create: expect.objectContaining({
          role: "reader",
          extraPermissions: ["download_audio"],
        }),
      })
    );
    expect(db.portalAdmission.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.pendingCatalogGrant.upsert.mock.invocationCallOrder[0]
    );
  });
  it.each([
    { catalogId: null, role: null },
    { catalogId: "20260202_000000", role: "reader" },
  ])("refuses standalone and foreign-source writes: %j", async (changes) => {
    const db = database();
    await expect(
      syncPendingAdmissionState(
        { ...input, ...changes } as never,
        {},
        db as never
      )
    ).rejects.toBeInstanceOf(ArchiveScopeError);
    expect(db.portalAdmission.updateMany).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it("refuses a null role on the configured source", async () => {
    const db = database();
    await expect(
      syncPendingAdmissionState({ ...input, role: null }, {}, db as never)
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
    expect(db.portalAdmission.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed if archive configuration is unavailable", async () => {
    const db = database();
    mocks.requireArchive.mockRejectedValue(
      new ArchiveConfigurationError("Archive unavailable")
    );
    await expect(
      syncPendingAdmissionState(input, {}, db as never)
    ).rejects.toBeInstanceOf(ArchiveConfigurationError);
    await expect(
      revokePendingAdmissionState(
        input,
        { actorId: "host-1", reason: "LAST_SPONSOR_REMOVED" },
        db as never
      )
    ).rejects.toBeInstanceOf(ArchiveConfigurationError);
    expect(db.portalAdmission.updateMany).not.toHaveBeenCalled();
  });
  it("updates a bound grant without rewriting legacy admission source or attribution", async () => {
    const db = database();
    await syncPendingAdmissionState(input, {}, db as never);
    const update = db.portalAdmission.updateMany.mock.calls[0][0];
    expect(update.data).toEqual({
      status: "PENDING",
      revocationReason: null,
      revokedById: null,
      revokedAt: null,
      notes: "invite",
    });
    expect(update.where).toMatchObject({
      email: "johndoe@gmail.com",
      status: { in: ["PENDING", "REVOKED"] },
      OR: [
        { revocationReason: null },
        { revocationReason: { not: "ADMIN_DENIED" } },
      ],
    });
  });
  it("blocks non-admin reopening of ADMIN_DENIED including concurrent denial", async () => {
    const denied = database("REVOKED", "ADMIN_DENIED");
    await expect(
      syncPendingAdmissionState(input, {}, denied as never)
    ).rejects.toBeInstanceOf(AdminDeniedAdmissionReopenError);
    expect(denied.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
    const raced = database();
    raced.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      syncPendingAdmissionState(input, {}, raced as never)
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
    expect(raced.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it("keeps pending edits separate from explicit reinvitation", async () => {
    const db = database();
    db.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      syncPendingAdmissionState(
        input,
        { allowAdminDeniedReopen: true, requirePending: true },
        db as never
      )
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
    expect(db.portalAdmission.updateMany.mock.calls[0][0].where.status).toBe(
      "PENDING"
    );
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it.each(["CLAIMED", "REVOKED"] as const)(
    "rejects a stale pending edit in %s state even for non-admins",
    async (status) => {
      const db = database(status, status === "REVOKED" ? "ADMIN_DENIED" : null);
      await expect(
        syncPendingAdmissionState(input, { requirePending: true }, db as never)
      ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
      expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
    }
  );
  it("conditions authorized grant edits on the old role/extras/status", async () => {
    const db = database();
    const expectedGrant = {
      role: "reader" as const,
      extraPermissions: ["download_audio"],
      status: "PENDING" as const,
    };
    await syncPendingAdmissionState(
      input,
      { requirePending: true, expectedGrant },
      db as never
    );
    expect(db.pendingCatalogGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: "johndoe@gmail.com",
          catalogId: ID,
          role: "reader",
          extraPermissions: { equals: ["download_audio"] },
          status: "PENDING",
        },
      })
    );
    db.pendingCatalogGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      syncPendingAdmissionState(
        input,
        { requirePending: true, expectedGrant },
        db as never
      )
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it("does not overwrite a concurrent grant after authorizing an absent grant", async () => {
    const db = database();
    db.pendingCatalogGrant.create.mockRejectedValue(
      new Error("Concurrent grant exists")
    );
    await expect(
      syncPendingAdmissionState(input, { expectedGrant: null }, db as never)
    ).rejects.toThrow("Concurrent grant exists");
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it("rolls back cancellation when its prechecked grant became protected", async () => {
    const db = database();
    db.pendingCatalogGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      revokePendingAdmissionState(
        input,
        {
          actorId: "host-1",
          reason: "LAST_SPONSOR_REMOVED",
          expectedGrant: {
            role: "reader",
            extraPermissions: [],
            status: "PENDING",
          },
        },
        db as never
      )
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
  });
  it("allows an authorized administrator to reopen denied access, but never CLAIMED access", async () => {
    const db = database("REVOKED", "ADMIN_DENIED");
    await syncPendingAdmissionState(
      input,
      { allowAdminDeniedReopen: true },
      db as never
    );
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledOnce();
    expect(db.portalAdmission.updateMany.mock.calls[0][0].where).toEqual({
      email: "johndoe@gmail.com",
      status: { in: ["PENDING", "REVOKED"] },
    });
    db.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      syncPendingAdmissionState(
        input,
        { allowAdminDeniedReopen: true },
        db as never
      )
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
  });
  it.each(["STANDALONE", "PENDING_GRANT"])(
    "revokes admission and only bound grant regardless of %s provenance or foreign sponsors",
    async () => {
      const db = database();
      await revokePendingAdmissionState(
        input,
        { actorId: "host-1", reason: "LAST_SPONSOR_REMOVED" },
        db as never
      );
      expect(db.portalAdmission.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: "johndoe@gmail.com", status: "PENDING" },
          data: expect.objectContaining({
            status: "REVOKED",
            revocationReason: "LAST_SPONSOR_REMOVED",
          }),
        })
      );
      expect(db.pendingCatalogGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: "johndoe@gmail.com",
            catalogId: ID,
            status: "PENDING",
          },
        })
      );
      expect(
        db.portalAdmission.updateMany.mock.invocationCallOrder[0]
      ).toBeLessThan(
        db.pendingCatalogGrant.updateMany.mock.invocationCallOrder[0]
      );
    }
  );
  it("cancels legacy unbacked admissions without granting/deleting foreign rows", async () => {
    const db = database();
    await revokePendingAdmissionState(
      { ...input, role: null, catalogId: null },
      { actorId: "admin-1", reason: "ADMIN_DENIED" },
      db as never
    );
    expect(
      db.pendingCatalogGrant.updateMany.mock.calls[0][0].where.catalogId
    ).toBe(ID);
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
  it("preserves an ADMIN_DENIED tombstone on repeated lower-privilege revoke", async () => {
    const db = database("REVOKED", "ADMIN_DENIED");
    db.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    await revokePendingAdmissionState(
      input,
      { actorId: "host-1", reason: "LAST_SPONSOR_REMOVED" },
      db as never
    );
    expect(db.portalAdmission.create).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.updateMany).toHaveBeenCalledOnce();
  });
  it("does not revoke a grant after a competing successful claim", async () => {
    const db = database("CLAIMED");
    db.portalAdmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      revokePendingAdmissionState(
        input,
        { actorId: "host-1", reason: "LAST_SPONSOR_REMOVED" },
        db as never
      )
    ).rejects.toBeInstanceOf(PendingAdmissionUnavailableError);
    expect(db.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
  });
});
