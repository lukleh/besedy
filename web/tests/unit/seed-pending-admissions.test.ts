import { describe, expect, it, vi } from "vitest";
import { syncSeedPendingAdmissions } from "../../prisma/seed-pending-admissions";

describe("seed pending admissions", () => {
  it("mirrors a catalog-backed pending admission into portal admission and pending grant", async () => {
    const invitedAt = new Date("2026-03-10T10:00:00.000Z");
    const db = {
      portalAdmission: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncSeedPendingAdmissions(db as never, {
      email: "User.Name+seed@GoogleMail.com",
      createdById: "admin-1",
      createdAt: invitedAt,
      catalogId: "20260101_000000",
      accessLevel: "EDITOR",
      notes: "seeded catalog invite",
    });

    expect(db.portalAdmission.upsert).toHaveBeenCalledWith({
      where: { email: "username@gmail.com" },
      create: expect.objectContaining({
        email: "username@gmail.com",
        source: "PENDING_GRANT",
        status: "PENDING",
        admittedById: "admin-1",
        admittedAt: invitedAt,
        notes: "seeded catalog invite",
      }),
      update: expect.objectContaining({
        source: "PENDING_GRANT",
        status: "PENDING",
        claimedById: null,
        claimedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: "seeded catalog invite",
      }),
    });
    expect(db.pendingCatalogGrant.deleteMany).toHaveBeenCalledWith({
      where: {
        email: "username@gmail.com",
        NOT: { catalogId: "20260101_000000" },
      },
    });
    expect(db.pendingCatalogGrant.upsert).toHaveBeenCalledWith({
      where: {
        email_catalogId: {
          email: "username@gmail.com",
          catalogId: "20260101_000000",
        },
      },
      create: expect.objectContaining({
        email: "username@gmail.com",
        catalogId: "20260101_000000",
        accessLevel: "EDITOR",
        status: "PENDING",
        grantedById: "admin-1",
        grantedAt: invitedAt,
        notes: "seeded catalog invite",
      }),
      update: expect.objectContaining({
        accessLevel: "EDITOR",
        status: "PENDING",
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: "seeded catalog invite",
      }),
    });
  });

  it("mirrors a standalone pending admission and clears all pending grants for the email", async () => {
    const invitedAt = new Date("2026-03-10T12:00:00.000Z");
    const db = {
      portalAdmission: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      pendingCatalogGrant: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };

    await syncSeedPendingAdmissions(db as never, {
      email: "pending@example.com",
      createdById: null,
      createdAt: invitedAt,
      catalogId: null,
      accessLevel: null,
      notes: "standalone allowlist",
    });

    expect(db.portalAdmission.upsert).toHaveBeenCalledWith({
      where: { email: "pending@example.com" },
      create: expect.objectContaining({
        email: "pending@example.com",
        source: "STANDALONE",
        status: "PENDING",
        admittedById: null,
        admittedAt: invitedAt,
        notes: "standalone allowlist",
      }),
      update: expect.objectContaining({
        source: "STANDALONE",
        status: "PENDING",
        admittedById: null,
        admittedAt: invitedAt,
        notes: "standalone allowlist",
      }),
    });
    expect(db.pendingCatalogGrant.deleteMany).toHaveBeenCalledWith({
      where: { email: "pending@example.com" },
    });
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
});
