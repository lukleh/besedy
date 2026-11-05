import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { CorrectionError } from "@/lib/correction/errors";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  listSpans,
  locateSpanPage,
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
  segment: z.string().optional(),
});

const SpanIdSchema = z.string().uuid();

/** The page asked for: at `offset`, or the one holding `segment`. */
async function resolvePageOffset(
  workspaceId: string,
  query: z.infer<typeof QuerySchema>
): Promise<number> {
  if (query.segment === undefined) return query.offset;
  const offset = SpanIdSchema.safeParse(query.segment).success
    ? await locateSpanPage(workspaceId, query.segment, query.limit)
    : null;
  if (offset === null) {
    throw new CorrectionError("SPAN_NOT_FOUND", "Span not found in this workspace");
  }
  return offset;
}

/**
 * GET - the working transcript.
 *
 * Paged, because a three-hour recording runs to several hundred spans and the
 * surface has to be able to stop and resume inside one. With `segment=<span
 * ID>` it returns the page holding that span instead of the one at `offset`,
 * so a shared link opens in a single request; a span that is not in this
 * workspace is SPAN_NOT_FOUND.
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
      segment: searchParams.get("segment") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json({ error: "Invalid paging" }, { status: 400 });
    }

    const workspace = await requireActiveWorkspace(catalogId, hash);
    const offset = await resolvePageOffset(workspace.id, query.data);
    const page = await listSpans(workspace.id, { offset, limit: query.data.limit });

    return NextResponse.json({
      workspaceId: workspace.id,
      offset,
      limit: query.data.limit,
      ...page,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
