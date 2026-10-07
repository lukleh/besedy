import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { SPAN_FILTERS } from "@/lib/correction/span-queries";
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
  filter: z.enum(SPAN_FILTERS).default("all"),
  /** Cursor for a filtered page: the ordinal of the last span already shown */
  after: z.coerce.number().int().min(-1).default(-1),
});

/**
 * GET - the working transcript.
 *
 * Paged, because a three-hour recording runs to several hundred spans and the
 * surface has to be able to stop and resume inside one. A filter narrows the
 * list to the spans that want attention. Its pages follow a cursor (`after`,
 * an ordinal) rather than an offset, because the selection changes with every
 * decision; `hasMore` says whether another page exists.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");

    const { searchParams } = new URL(request.url);
    const query = QuerySchema.safeParse({
      offset: searchParams.get("offset") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      filter: searchParams.get("filter") ?? undefined,
      after: searchParams.get("after") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json({ error: "Invalid paging" }, { status: 400 });
    }

    const workspace = await requireActiveWorkspace(catalogId, hash);
    const page = await listSpans(workspace.id, {
      offset: query.data.offset,
      limit: query.data.limit,
      filter: query.data.filter,
      afterOrdinal: query.data.after,
      actorKey: userId,
    });

    return NextResponse.json({
      workspaceId: workspace.id,
      offset: query.data.offset,
      limit: query.data.limit,
      filter: query.data.filter,
      ...page,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
