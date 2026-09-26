import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { addComment } from "@/lib/correction/decision-service";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  hash: HashSchema,
  spanId: z.string().uuid(),
});

const CommentSchema = z
  .object({
    revisionId: z.string().uuid(),
    body: z.string().min(1).max(4000),
  })
  .strict();

interface RouteParams {
  params: Promise<{ id: string; hash: string; spanId: string }>;
}

/**
 * Comments never block publication and do not fail because the text moved
 * while one was being written: they record the revision the author saw.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash, spanId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, CommentSchema);
    if (!bodyResult.success) return bodyResult.response;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    const comment = await addComment({
      workspaceId: workspace.id,
      spanId,
      userId,
      revisionId: bodyResult.data.revisionId,
      body: bodyResult.data.body,
    });

    return NextResponse.json(comment, { status: 201 });
  } catch (error) {
    return handleCorrectionRouteError(error, "create");
  }
}
