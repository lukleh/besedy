import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { recordFlag } from "@/lib/correction/flag-service";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  hash: HashSchema,
  spanId: z.string().uuid(),
});

interface RouteParams {
  params: Promise<{ id: string; hash: string; spanId: string }>;
}

const FlagSchema = z
  .object({
    kind: z.enum(["UNCLEAR", "OVERLAP", "OTHER_LANGUAGE", "MUSIC_NOISE", "CUT_WORD", "EXCLUDE_FROM_TRAINING"]),
    action: z.enum(["SET", "CLEAR"]),
    /** ISO 639-1, only with OTHER_LANGUAGE */
    languageCode: z.string().regex(/^[a-z]{2}$/).nullish(),
    comment: z.string().max(2_000).nullish(),
    idempotencyKey: z.string().min(1).max(64).nullish(),
  })
  .strict();

/** POST - set or clear one flag on a span's audio (ADR 0012). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash, spanId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, FlagSchema);
    if (!bodyResult.success) return bodyResult.response;
    const body = bodyResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    const result = await recordFlag({
      workspaceId: workspace.id,
      spanId,
      userId,
      kind: body.kind,
      action: body.action,
      languageCode: body.languageCode ?? null,
      comment: body.comment ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return NextResponse.json({ spanId, ...result });
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
