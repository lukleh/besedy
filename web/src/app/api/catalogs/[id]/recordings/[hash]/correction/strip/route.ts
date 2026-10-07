import { NextRequest, NextResponse } from "next/server";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { loadSpanStrip } from "@/lib/correction/span-queries";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

/**
 * GET - every span's position and state, without its text.
 *
 * The strip over the whole recording needs the shape of the work, not the
 * words, so a multi-hour workspace costs a few kilobytes rather than the whole
 * transcript.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    return NextResponse.json({
      workspaceId: workspace.id,
      spans: await loadSpanStrip(workspace.id, userId),
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
