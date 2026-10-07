import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { findNextOpenSpan } from "@/lib/correction/span-queries";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const QuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
});

/**
 * GET - the next span that still wants this person, after the given ordinal
 * and wrapping round to the start. `null` means nothing is left for them.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");

    const query = QuerySchema.safeParse({
      after: new URL(request.url).searchParams.get("after") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json({ error: "Invalid position" }, { status: 400 });
    }

    const workspace = await requireActiveWorkspace(catalogId, hash);
    return NextResponse.json({
      next: await findNextOpenSpan(workspace.id, userId, query.data.after),
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
