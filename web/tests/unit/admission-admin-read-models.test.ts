import { describe, expect, it, vi } from "vitest";
import {
  countPendingPortalAdmissions,
  listPendingAdminAdmissions,
} from "@/lib/admission/admin-read-models";

describe("admission admin read models", () => {
  it("maps pending admissions into the existing admin pending-item shape", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "pending@example.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: null,
            admittedById: null,
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "pending@example.com",
            catalogId: "20260101_000000",
            accessLevel: "EDITOR",
            notes: "catalog note",
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            grantedById: "owner-1",
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "owner-1",
            name: "Owner User",
            email: "owner@example.com",
          },
        ]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "20260101_000000",
            label: "Catalog One",
          },
        ]),
      },
    };

    const result = await listPendingAdminAdmissions("pending", db as never);

    expect(db.portalAdmission.findMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        email: {
          contains: "pending",
          mode: "insensitive",
        },
      },
      select: {
        id: true,
        email: true,
        admittedAt: true,
        notes: true,
        admittedById: true,
      },
      orderBy: { admittedAt: "desc" },
    });
    expect(db.pendingCatalogGrant.findMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        email: { in: ["pending@example.com"] },
      },
      select: {
        email: true,
        catalogId: true,
        accessLevel: true,
        notes: true,
        grantedAt: true,
        grantedById: true,
      },
      orderBy: [{ grantedAt: "desc" }, { catalogId: "asc" }],
    });
    expect(result).toEqual([
      {
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
        invitedAt: "2026-03-10T10:00:00.000Z",
        pendingGrants: [
          {
            catalogId: "20260101_000000",
            catalogLabel: "Catalog One",
            accessLevel: "EDITOR",
            grantedAt: "2026-03-10T11:00:00.000Z",
            grantedBy: {
              id: "owner-1",
              name: "Owner User",
              email: "owner@example.com",
            },
            notes: "catalog note",
          },
        ],
        catalogNames: ["Catalog One"],
        pendingGrantCount: 1,
        catalogId: "20260101_000000",
        catalogLabel: "Catalog One",
        accessLevel: "EDITOR",
        invitedBy: {
          id: "owner-1",
          name: "Owner User",
          email: "owner@example.com",
        },
        notes: "catalog note",
      },
    ]);
  });

  it("falls back to catalog id when the catalog label is blank", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "pending@example.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: null,
            admittedById: null,
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "pending@example.com",
            catalogId: "20260101_000000",
            accessLevel: "VIEWER",
            notes: null,
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            grantedById: null,
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "20260101_000000",
            label: "",
          },
        ]),
      },
    };

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result).toEqual([
      expect.objectContaining({
        id: "pending@example.com",
        status: "PENDING",
        pendingGrants: [
          expect.objectContaining({
            catalogId: "20260101_000000",
            catalogLabel: "20260101_000000",
          }),
        ],
        catalogNames: ["20260101_000000"],
        pendingGrantCount: 1,
        catalogLabel: "20260101_000000",
      }),
    ]);
  });

  it("returns null catalog/access and invitedBy when admission has no pending grant and no admittedBy actor", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "nogrant@example.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: "admission only",
            admittedById: "missing-admin",
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result).toEqual([
      {
        id: "nogrant@example.com",
        email: "nogrant@example.com",
        status: "PENDING",
        invitedAt: "2026-03-10T10:00:00.000Z",
        pendingGrants: [],
        catalogNames: [],
        pendingGrantCount: 0,
        catalogId: null,
        catalogLabel: null,
        accessLevel: null,
        invitedBy: null,
        notes: "admission only",
      },
    ]);
  });

  it("keeps admissions visible without requiring compatibility invitation rows", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "orphan@example.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: null,
            admittedById: null,
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("orphan@example.com");
    expect(result[0].id).toBe("orphan@example.com");
    expect(result[0].pendingGrants).toEqual([]);
    expect(result[0].catalogNames).toEqual([]);
    expect(result[0].pendingGrantCount).toBe(0);
  });

  it("keeps canonical email keys without requiring legacy invitation joins", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "johndoe@gmail.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: null,
            admittedById: null,
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "johndoe@gmail.com",
            catalogId: "20260101_000000",
            accessLevel: "VIEWER",
            notes: null,
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            grantedById: null,
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "20260101_000000",
            label: "Catalog One",
          },
        ]),
      },
    };

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result).toEqual([
      expect.objectContaining({
        id: "johndoe@gmail.com",
        email: "johndoe@gmail.com",
        status: "PENDING",
        pendingGrants: [
          expect.objectContaining({
            catalogId: "20260101_000000",
            catalogLabel: "Catalog One",
          }),
        ],
        catalogNames: ["Catalog One"],
        pendingGrantCount: 1,
        catalogLabel: "Catalog One",
      }),
    ]);
  });

  it("summarizes multiple pending grants without pretending one catalog is the whole admission", async () => {
    const db = {
      portalAdmission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "portal-1",
            email: "pending@example.com",
            admittedAt: new Date("2026-03-10T10:00:00.000Z"),
            notes: "admission note",
            admittedById: null,
          },
        ]),
      },
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "pending@example.com",
            catalogId: "20260102_000000",
            accessLevel: "MEMBER",
            notes: "second grant",
            grantedAt: new Date("2026-03-10T12:00:00.000Z"),
            grantedById: "owner-2",
          },
          {
            email: "pending@example.com",
            catalogId: "20260101_000000",
            accessLevel: "VIEWER",
            notes: "first grant",
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            grantedById: "owner-1",
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "owner-2",
            name: "Second Owner",
            email: "owner2@example.com",
          },
        ]),
      },
      workflowGroup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "20260101_000000",
            label: "Catalog One",
          },
          {
            id: "20260102_000000",
            label: "Catalog Two",
          },
        ]),
      },
    };

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result).toEqual([
      {
        id: "pending@example.com",
        email: "pending@example.com",
        status: "PENDING",
        invitedAt: "2026-03-10T10:00:00.000Z",
        pendingGrants: [
          {
            catalogId: "20260102_000000",
            catalogLabel: "Catalog Two",
            accessLevel: "MEMBER",
            grantedAt: "2026-03-10T12:00:00.000Z",
            grantedBy: {
              id: "owner-2",
              name: "Second Owner",
              email: "owner2@example.com",
            },
            notes: "second grant",
          },
          {
            catalogId: "20260101_000000",
            catalogLabel: "Catalog One",
            accessLevel: "VIEWER",
            grantedAt: "2026-03-10T11:00:00.000Z",
            grantedBy: null,
            notes: "first grant",
          },
        ],
        catalogNames: ["Catalog Two", "Catalog One"],
        pendingGrantCount: 2,
        catalogId: null,
        catalogLabel: null,
        accessLevel: "MEMBER",
        invitedBy: {
          id: "owner-2",
          name: "Second Owner",
          email: "owner2@example.com",
        },
        notes: "admission note",
      },
    ]);
  });

  it("counts pending portal admissions", async () => {
    const db = {
      portalAdmission: {
        count: vi.fn().mockResolvedValue(7),
      },
    };

    const result = await countPendingPortalAdmissions(db as never);

    expect(result).toBe(7);
    expect(db.portalAdmission.count).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
  });
});
