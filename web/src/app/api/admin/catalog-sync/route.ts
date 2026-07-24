import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handlePrismaError, validateMutationSource } from "@/lib/api";
import { syncActiveCatalogs, syncCatalogGroup } from "@/lib/catalog-sync";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SyncRequestSchema = z.object({
  groupId: z.string().trim().length(15).optional(),
  force: z.boolean().optional().default(false),
  allowRowCountDrop: z.boolean().optional().default(false),
});

/**
 * GET /api/admin/catalog-sync
 * Returns latest sync-state snapshots for active groups.
 */
export async function GET() {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    return NextResponse.json({
      ok: true,
      message: "Use POST to trigger sync. Query catalog_sync_state via SQL for detailed status.",
    });
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
      return NextResponse.json(response, { status: 500 });
    }

    return NextResponse.json(response);
  } catch (error) {
    return handlePrismaError(error, "catalog sync", "create");
  }
}
