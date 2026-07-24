import type { PrismaClient } from "@/generated/prisma/client";
import prisma from "@/lib/db";

type CatalogAdmissionReadClient = Pick<PrismaClient, "pendingCatalogGrant">;

export interface PendingCatalogGrantItem {
  id: string;
  type: "pending_catalog_grant";
  email: string;
  accessLevel:
    | "LISTENER"
    | "VIEWER"
    | "MEMBER"
    | "EDITOR"
    | "OWNER";
  notes: string | null;
  createdAt: string;
  grantedBy: { id: string; name: string | null; email: string | null } | null;
}

export async function listPendingCatalogUsers(
  catalogId: string,
  db: CatalogAdmissionReadClient = prisma
): Promise<PendingCatalogGrantItem[]> {
  const pendingGrants = await db.pendingCatalogGrant.findMany({
    where: {
      catalogId,
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

  return pendingGrants.map((grant) => ({
    id: grant.email,
    type: "pending_catalog_grant" as const,
    email: grant.email,
    accessLevel: grant.accessLevel,
    notes: grant.notes,
    createdAt: grant.grantedAt.toISOString(),
    grantedBy: grant.grantedBy,
  }));
}
