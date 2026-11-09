import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  reconcilePublication,
  rollbackPublication,
} from "@/lib/correction/publication-service";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

/**
 * Administrative recovery for an unfinished publication.
 *
 * `reconcile` finishes an activation that crashed after its artifacts were
 * written; `rollback` abandons one and restores the previous effective source
 * for this recording alone. Ordinary Unpublish retracts corrected text from
 * both reading and search through the publisher's DELETE route.
 */
const RecoverBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reconcile"),
    publicationId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("rollback"),
    publicationId: z.string().uuid(),
  }),
]);

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, RecoverBodySchema);
    if (!bodyResult.success) return bodyResult.response;
    const command = bodyResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "administer");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    let result: Record<string, unknown>;
    switch (command.action) {
      // Every branch is scoped to the workspace the access check authorized:
      // a publication id alone must never reach across catalogs.
      case "reconcile":
        result = {
          status: await reconcilePublication(
            command.publicationId,
            workspace.id
          ),
        };
        break;
      case "rollback":
        result = { status: await rollbackPublication(command.publicationId, workspace.id) };
        break;
    }

    await logAuditEvent({
      userId,
      // Reconciling completes an activation and makes the transcript readable;
      // rollback abandons the candidate. Recording both as an unpublish would
      // make the log say the opposite of what happened.
      action:
        command.action === "reconcile"
          ? "TRANSCRIPT_PUBLISHED"
          : "TRANSCRIPT_UNPUBLISHED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
      payload: {
        workspaceId: workspace.id,
        recovery: command.action,
        ...("publicationId" in command
          ? { publicationId: command.publicationId }
          : {}),
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
