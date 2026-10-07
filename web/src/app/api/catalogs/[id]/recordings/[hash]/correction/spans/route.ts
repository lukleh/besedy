import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  listSpans,
  requireActiveWorkspace,
} from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const QuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * GET - the working transcript.
 *
 * Paged, because a three-hour recording runs to several hundred spans and the
 * surface has to be able to stop and resume inside one.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    await requireCorrectionAccess(catalogId, hash, "correct");

    const { searchParams } = new URL(request.url);
    const query = QuerySchema.safeParse({
      offset: searchParams.get("offset") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json({ error: "Invalid paging" }, { status: 400 });
    }

    const workspace = await requireActiveWorkspace(catalogId, hash);
    const page = await listSpans(workspace.id, {
      offset: query.data.offset,
      limit: query.data.limit,
    });

    return NextResponse.json({
      workspaceId: workspace.id,
      offset: query.data.offset,
      limit: query.data.limit,
      ...page,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
