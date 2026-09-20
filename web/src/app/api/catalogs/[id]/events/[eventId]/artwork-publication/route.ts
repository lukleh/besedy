import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams, validateRequestBody } from "@/lib/api/validation";
import { requireEventArtworkAccess } from "@/lib/event-artwork-access";
import { handleEventArtworkRouteError } from "@/lib/event-artwork-route-errors";
import { publishEventArtwork, unpublishEventArtwork } from "@/lib/event-artwork-service";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});
const PublishBodySchema = z.object({ artworkId: z.string().uuid() }).strict();
interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const bodyResult = await validateRequestBody(request, PublishBodySchema);
    if (!bodyResult.success) return bodyResult.response;
    const { userId } = await requireEventArtworkAccess(catalogId, eventId, "publish");
    const result = await publishEventArtwork({
      catalogId,
      eventId,
      artworkId: bodyResult.data.artworkId,
      userId,
    });
    return NextResponse.json({
      published: true,
      artworkId: bodyResult.data.artworkId,
      ...result,
    });
  } catch (error) {
    return handleEventArtworkRouteError(error, "update");
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const { userId } = await requireEventArtworkAccess(catalogId, eventId, "publish");
    const result = await unpublishEventArtwork({ catalogId, eventId, userId });
    return NextResponse.json({ published: false, ...result });
  } catch (error) {
    return handleEventArtworkRouteError(error, "update");
  }
}
