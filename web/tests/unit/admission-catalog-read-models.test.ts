import { describe, expect, it, vi } from "vitest";
import { listPendingCatalogUsers } from "@/lib/admission/catalog-read-models";

describe("catalog admission read models", () => {
  it("maps pending grants into the pending-catalog-grant shape", async () => {
    const db = {
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "pending@example.com",
            accessLevel: "EDITOR",
            notes: "pending note",
            grantedAt: new Date("2026-03-10T10:00:00.000Z"),
            grantedBy: {
              id: "owner-1",
              name: "Owner User",
              email: "owner@example.com",
            },
          },
        ]),
      },
    };

    const result = await listPendingCatalogUsers("20260101_000000", db as never);

    expect(db.pendingCatalogGrant.findMany).toHaveBeenCalledWith({
      where: {
        catalogId: "20260101_000000",
        status: "PENDING",
      },
      select: {
        email: true,
        accessLevel: true,
        notes: true,
        grantedAt: true,
        grantedBy: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [{ grantedAt: "desc" }, { email: "asc" }],
    });
    expect(result).toEqual([
      {
        id: "pending@example.com",
        type: "pending_catalog_grant",
        email: "pending@example.com",
        accessLevel: "EDITOR",
        notes: "pending note",
        createdAt: "2026-03-10T10:00:00.000Z",
        grantedBy: {
          id: "owner-1",
          name: "Owner User",
          email: "owner@example.com",
        },
      },
    ]);
  });

  it("joins legacy Gmail invitations back by canonical email", async () => {
    const db = {
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "johndoe@gmail.com",
            accessLevel: "VIEWER",
            notes: "shadow note",
            grantedAt: new Date("2026-03-10T11:00:00.000Z"),
            grantedBy: {
              id: "admin-1",
              name: "Admin User",
              email: "admin@example.com",
            },
          },
        ]),
      },
    };

    const result = await listPendingCatalogUsers("20260101_000000", db as never);

    expect(result).toEqual([
      {
        id: "johndoe@gmail.com",
        type: "pending_catalog_grant",
        email: "johndoe@gmail.com",
        accessLevel: "VIEWER",
        notes: "shadow note",
        createdAt: "2026-03-10T11:00:00.000Z",
        grantedBy: {
          id: "admin-1",
          name: "Admin User",
          email: "admin@example.com",
        },
      },
    ]);
  });

  it("lists pending grants without requiring compatibility invitation rows", async () => {
    const db = {
      pendingCatalogGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            email: "orphan@example.com",
            accessLevel: "VIEWER",
            notes: null,
            grantedAt: new Date("2026-03-10T10:00:00.000Z"),
            grantedBy: null,
          },
        ]),
      },
    };

    const result = await listPendingCatalogUsers("20260101_000000", db as never);

    expect(result).toEqual([
      {
        id: "orphan@example.com",
        type: "pending_catalog_grant",
        email: "orphan@example.com",
        accessLevel: "VIEWER",
        notes: null,
        createdAt: "2026-03-10T10:00:00.000Z",
        grantedBy: null,
      },
    ]);
  });
});
