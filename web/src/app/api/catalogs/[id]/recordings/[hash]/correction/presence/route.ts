import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { clearPresence, loadPresence, recordPresence } from "@/lib/correction/presence";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PresenceSchema = z
  .object({
    spanId: z.string().uuid().nullable(),
    editing: z.boolean(),
  })
  .strict();

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

/**
 * PUT - the page's heartbeat: where this person is, answered with where the
 * others are.
 *
 * Advisory only. It takes no workspace lock, so it never waits behind a
 * publication, and nothing that writes correction data reads it.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, PresenceSchema);
    if (!bodyResult.success) return bodyResult.response;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    await recordPresence({ workspaceId: workspace.id, userId, ...bodyResult.data });
    const present = await loadPresence([workspace.id], userId);

    return NextResponse.json({
      workspaceId: workspace.id,
      people: present.get(workspace.id) ?? [],
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}

/** DELETE - this person left the page. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");
    const workspace = await requireActiveWorkspace(catalogId, hash);
    await clearPresence(workspace.id, userId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleCorrectionRouteError(error, "delete");
  }
}
