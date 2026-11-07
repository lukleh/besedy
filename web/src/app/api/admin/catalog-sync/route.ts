import { assertArchiveCatalogId } from '@/lib/archive';
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handlePrismaError, notFound, validateMutationSource } from "@/lib/api";
import { syncActiveCatalogs, syncCatalogGroup } from "@/lib/catalog-sync";
import { requireAdminCapability } from "@/lib/access/require-admin";
import prisma from "@/lib/db";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import { CATALOG_SYNC_SOURCE_KEYS } from "@/lib/catalog-sync/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SyncRequestSchema = z.object({
  groupId: z.string().trim().length(15).optional(),
  force: z.boolean().optional().default(false),
  allowRowCountDrop: z.boolean().optional().default(false),
});

/**
 * GET /api/admin/catalog-sync
 * Returns at most three source snapshots for one catalog. Error details may
 * name source paths, so this stays behind the system-admin boundary.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const parsed = TimestampIdSchema.safeParse(request.nextUrl.searchParams.get("groupId"));
    if (!parsed.success) return badRequest("A valid groupId is required");
    const groupId = parsed.data;
    await assertArchiveCatalogId(groupId);
    const group = await prisma.workflowGroup.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!group) return notFound("catalog");
    const sources = await prisma.catalogSyncState.findMany({
      where: { workflowGroupId: groupId, sourceKey: { in: [...CATALOG_SYNC_SOURCE_KEYS] } },
      take: CATALOG_SYNC_SOURCE_KEYS.length,
      orderBy: { sourceKey: "asc" },
      select: {
        sourceKey: true, status: true, syncedAt: true,
        lastSuccessfulAt: true, lastError: true, rowCount: true,
      },
    });
    return NextResponse.json({ groupId, sources });
  } catch (error) {
    return handlePrismaError(error, "catalog sync", "fetch");
  }
}

/**
 * POST /api/admin/catalog-sync
 * Body: { groupId?: string, force?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    await requireAdminCapability({ message: "Unauthorized" });

    const body = await request.json().catch(() => ({}));
    const parsed = SyncRequestSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message || "Invalid sync payload");
    }

    const { groupId, force, allowRowCountDrop } = parsed.data;

    const startedAt = new Date();
    const results = groupId
      ? [await syncCatalogGroup(groupId, { force, allowRowCountDrop })]
      : await syncActiveCatalogs({ force, allowRowCountDrop });

    const failed = results.filter((result) => result.status === "error");
    const response = {
      ok: failed.length === 0,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      force,
      allowRowCountDrop,
      groupId: groupId ?? null,
      totals: {
        all: results.length,
        success: results.filter((result) => result.status === "success").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        error: failed.length,
      },
      results,
    };

    if (failed.length > 0) {
      return NextResponse.json({
        ...response,
        error: failed.map((result) => `${result.groupId}: ${result.error ?? "Catalog sync failed"}`).join("\n"),
      }, { status: 500 });
    }

    return NextResponse.json(response);
  } catch (error) {
    return handlePrismaError(error, "catalog sync", "create");
  }
}
