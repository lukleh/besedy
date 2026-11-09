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
      role: "curator",
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
        role: "curator",
        status: "PENDING",
        grantedById: "admin-1",
        grantedAt: invitedAt,
        notes: "seeded catalog invite",
      }),
      update: expect.objectContaining({
        role: "curator",
        status: "PENDING",
        consumedById: null,
        consumedAt: null,
        revokedById: null,
        revokedAt: null,
        notes: "seeded catalog invite",
      }),
    });
  });

  it.each([
    { catalogId: null, role: null },
    { catalogId: "20260101_000000", role: null },
    { catalogId: null, role: "reader" },
    { catalogId: undefined, role: "reader" },
    { catalogId: "20260101_000000", role: undefined },
    { catalogId: "", role: "reader" },
  ])("rejects an unbacked invitation before writing: %j", async (grant) => {
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

    await expect(
      syncSeedPendingAdmissions(
        db as never,
        {
          email: "pending@example.com",
          createdById: null,
          createdAt: invitedAt,
          ...grant,
          notes: "unbacked fixture",
        } as never,
      ),
    ).rejects.toThrow("Seed invitations require a catalog and role");

    expect(db.portalAdmission.upsert).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.deleteMany).not.toHaveBeenCalled();
    expect(db.pendingCatalogGrant.upsert).not.toHaveBeenCalled();
  });
});
