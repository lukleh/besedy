import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { findNextSpan, SPAN_KINDS } from "@/lib/correction/span-queries";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const QuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  kind: z.enum(SPAN_KINDS).default("mine_open"),
});

/**
 * GET - the next span of a kind after the given ordinal, wrapping round to the
 * start. The default kind is what still wants this person. `null` means no
 * span of that kind is left.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");

    const { searchParams } = new URL(request.url);
    const query = QuerySchema.safeParse({
      after: searchParams.get("after") ?? undefined,
      kind: searchParams.get("kind") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json({ error: "Invalid position" }, { status: 400 });
    }

    const workspace = await requireActiveWorkspace(catalogId, hash);
    return NextResponse.json({
      next: await findNextSpan(workspace.id, userId, {
        kind: query.data.kind,
        afterOrdinal: query.data.after,
      }),
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
