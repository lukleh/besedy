import { NextResponse } from "next/server";
import { discoverGroups, formatTimestampLabel } from "@/lib/groups";
import { getCatalogsDir } from "@/lib/paths";
import prisma from "@/lib/db";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { handlePrismaError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/catalogs/discover - Discover workflow groups from filesystem
 *
 * Scans the catalogs directory (from besedy.toml config) for timestamp-patterned
 * workflow groups and returns those not yet registered in the database.
 *
 * Requires: superadmin or canManageCatalogs capability
 */
export async function GET() {
  try {
    await requireAdminCapability({
      message: "Permission denied. Requires catalog management access.",
    });

    // Get catalogs directory from config
    const catalogsDir = getCatalogsDir();

    // Discover groups from filesystem
    const discovered = await discoverGroups();

    // Get existing groups from database
    const existing = await prisma.workflowGroup.findMany({
      select: { id: true },
    });
    const existingIds = new Set(existing.map((g) => g.id));

    // Filter to only new groups and add formatted labels
    const newGroups = discovered
      .filter((g) => !existingIds.has(g.id))
      .map((g) => ({
        ...g,
        label: formatTimestampLabel(g.id),
      }));

    return NextResponse.json({
      catalogsDir,
      discovered: discovered.length,
      new: newGroups.length,
      groups: newGroups,
    });
  } catch (error) {
    return handlePrismaError(error, "catalogs", "fetch");
  }
}
