import { describe, expect, it, vi } from "vitest";
import {
  AdminDeniedAdmissionReopenError,
  revokePendingAdmissionState,
  syncPendingAdmissionState,
} from "@/lib/admission/pending-admission-sync";

describe("pending admission sync", () => {
  it("syncs a standalone pending admission into portal admission without revoking pending grants", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: null,
        accessLevel: null,
        createdById: "admin-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "allowlisted",
      },
      {},
      db as never
    );

    expect(db.portalAdmission.upsert).toHaveBeenCalledWith({
      where: { email: "pending@example.com" },
      create: expect.objectContaining({
        email: "pending@example.com",
        source: "STANDALONE",
        status: "PENDING",
        admittedById: "admin-1",
        notes: "allowlisted",
      }),
      update: expect.objectContaining({
        source: "STANDALONE",
        status: "PENDING",
        admittedById: "admin-1",
        revokedById: null,
        revokedAt: null,
        notes: "allowlisted",
      }),
    });
    expect(db.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
  });

  it("syncs a catalog-backed pending admission into portal admission and pending grant", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "owner-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {},
      db as never
    );

    expect(db.portalAdmission.upsert).toHaveBeenCalledWith({
      where: { email: "pending@example.com" },
      create: expect.objectContaining({
        source: "PENDING_GRANT",
        status: "PENDING",
      }),
      update: expect.objectContaining({
        source: "PENDING_GRANT",
        status: "PENDING",
      }),
    });
    expect(db.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith({
      where: {
        email_catalogId: {
          email: "pending@example.com",
          catalogId: "20260101_000000",
        },
      },
      create: expect.objectContaining({
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        status: "PENDING",
        grantedById: "owner-1",
        notes: "catalog invite",
      }),
      update: expect.objectContaining({
        accessLevel: "EDITOR",
        status: "PENDING",
        grantedById: "owner-1",
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: "catalog invite",
      }),
    });
  });

  it("writes shadow rows using canonical email keys", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "John.Doe+tag@googlemail.com",
        catalogId: "20260101_000000",
        accessLevel: "VIEWER",
        createdById: "owner-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {},
      db as never
    );

    expect(db.portalAdmission.findUnique).toHaveBeenCalledWith({
      where: { email: "johndoe@gmail.com" },
      select: {
        source: true,
        status: true,
        revocationReason: true,
        admittedById: true,
        admittedAt: true,
        notes: true,
      },
    });
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email_catalogId: {
            email: "johndoe@gmail.com",
            catalogId: "20260101_000000",
          },
        },
      })
    );
  });

  it("keeps sibling pending grants active when another catalog grant is synced", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          source: "PENDING_GRANT",
          status: "PENDING",
          revocationReason: null,
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260102_000000",
        accessLevel: "MEMBER",
        createdById: "owner-2",
        createdAt: new Date("2026-03-10T12:00:00.000Z"),
        notes: "second sponsorship",
      },
      {},
      db as never
    );

    expect(db.pendingCatalogGrant.updateMany).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email_catalogId: {
            email: "pending@example.com",
            catalogId: "20260102_000000",
          },
        },
      })
    );
  });

  it("revokes all pending grants for admin-denied admissions", async () => {
    const db = {
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          source: "PENDING_GRANT",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await revokePendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "admin-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {
        actorId: "admin-2",
        reason: "ADMIN_DENIED",
        revokeAllPendingGrantsForEmail: true,
      },
      db as never
    );

    expect(db.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: {
        email: "pending@example.com",
        status: "PENDING",
      },
      data: expect.objectContaining({
        status: "REVOKED",
        revokedById: "admin-2",
      }),
    });
    expect(db.portalAdmission.upsert).toHaveBeenCalledWith({
      where: { email: "pending@example.com" },
      create: expect.objectContaining({
        status: "REVOKED",
        revocationReason: "ADMIN_DENIED",
        revokedById: "admin-2",
      }),
      update: expect.objectContaining({
        status: "REVOKED",
        revocationReason: "ADMIN_DENIED",
        revokedById: "admin-2",
      }),
    });
  });

  it("keeps admission pending when other catalog grants remain", async () => {
    const db = {
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(1),
      },
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          source: "PENDING_GRANT",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await revokePendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "owner-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: null,
      },
      {
        actorId: "owner-1",
        reason: "LAST_SPONSOR_REMOVED",
      },
      db as never
    );

    expect(db.portalAdmission.upsert).not.toHaveBeenCalled();
  });

  it("blocks non-admins from reopening admin-denied admissions", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          status: "REVOKED",
          revocationReason: "ADMIN_DENIED",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      syncPendingAdmissionState(
        {
          email: "pending@example.com",
          catalogId: "20260101_000000",
          accessLevel: "EDITOR",
          createdById: "owner-1",
          createdAt: new Date("2026-03-10T10:00:00.000Z"),
          notes: "catalog invite",
        },
        {},
        db as never
      )
    ).rejects.toBeInstanceOf(AdminDeniedAdmissionReopenError);
    expect(db.portalAdmission.upsert).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });

  it("allows admins to reopen admin-denied admissions", async () => {
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          status: "REVOKED",
          revocationReason: "ADMIN_DENIED",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "admin-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {
        allowAdminDeniedReopen: true,
      },
      db as never
    );

    expect(db.portalAdmission.upsert).toHaveBeenCalledOnce();
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledOnce();
  });

  it("preserves standalone admission provenance when adding a pending catalog grant", async () => {
    const standaloneAdmittedAt = new Date("2026-03-09T09:00:00.000Z");
    const db = {
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          source: "STANDALONE",
          status: "PENDING",
          revocationReason: null,
          admittedById: "admin-1",
          admittedAt: standaloneAdmittedAt,
          notes: "original standalone note",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncPendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "owner-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {},
      db as never
    );

    expect(db.portalAdmission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: "STANDALONE",
          admittedById: "admin-1",
          admittedAt: standaloneAdmittedAt,
          notes: "original standalone note",
        }),
        update: expect.objectContaining({
          source: "STANDALONE",
          admittedById: "admin-1",
          admittedAt: standaloneAdmittedAt,
          notes: "original standalone note",
        }),
      })
    );
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          grantedById: "owner-1",
          notes: "catalog invite",
        }),
        update: expect.objectContaining({
          grantedById: "owner-1",
          notes: "catalog invite",
        }),
      })
    );
  });

  it("preserves standalone portal admission when the last sponsor is removed", async () => {
    const db = {
      pendingCatalogGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      portalAdmission: {
        findUnique: vi.fn().mockResolvedValue({
          source: "STANDALONE",
        }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await revokePendingAdmissionState(
      {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        createdById: "owner-1",
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        notes: "catalog invite",
      },
      {
        actorId: "owner-1",
        reason: "LAST_SPONSOR_REMOVED",
      },
      db as never
    );

    expect(db.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: {
        email: "pending@example.com",
        catalogId: "20260101_000000",
        status: "PENDING",
      },
      data: expect.objectContaining({
        status: "REVOKED",
        revokedById: "owner-1",
      }),
    });
    expect(db.portalAdmission.upsert).not.toHaveBeenCalled();
  });
});
