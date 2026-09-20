import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  listSpanHistory,
  recordDecision,
  saveAndApprove,
} from "@/lib/correction/decision-service";
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

/**
 * Every command names the revision the person had in front of them, and may
 * carry an idempotency key so a double-click or a retried request cannot
 * record the same decision twice.
 */
const CommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    expectedRevisionId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(64).nullish(),
  }),
  z.object({
    action: z.literal("disapprove"),
    expectedRevisionId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(64).nullish(),
  }),
  z.object({
    action: z.literal("withdraw"),
    expectedRevisionId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(64).nullish(),
  }),
  z.object({
    action: z.literal("save_and_approve"),
    expectedRevisionId: z.string().uuid(),
    text: z.string().max(20_000),
    idempotencyKey: z.string().min(1).max(64).nullish(),
  }),
]);

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash, spanId } = paramsResult.data;

    await requireCorrectionAccess(catalogId, hash, "correct");
    await requireActiveWorkspace(catalogId, hash);

    return NextResponse.json({ spanId, history: await listSpanHistory(spanId) });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash, spanId } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, CommandSchema);
    if (!bodyResult.success) return bodyResult.response;
    const command = bodyResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    const base = {
      workspaceId: workspace.id,
      spanId,
      userId,
      expectedRevisionId: command.expectedRevisionId,
      idempotencyKey: command.idempotencyKey ?? null,
    };

    const result =
      command.action === "save_and_approve"
        ? await saveAndApprove({ ...base, text: command.text })
        : await recordDecision({
            ...base,
            kind:
              command.action === "approve"
                ? "APPROVE"
                : command.action === "disapprove"
                  ? "DISAPPROVE"
                  : "WITHDRAW",
          });

    return NextResponse.json(result);
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
