import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams, validateRequestBody } from "@/lib/api/validation";
import { requireEventPosterAccess } from "@/lib/event-poster-access";
import { handleEventPosterRouteError } from "@/lib/event-poster-route-errors";
import { publishEventPoster, unpublishEventPoster } from "@/lib/event-poster-service";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});
const PublishBodySchema = z.object({ posterId: z.string().uuid() }).strict();
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
    const { userId } = await requireEventPosterAccess(catalogId, eventId, "publish");
    const result = await publishEventPoster({
      catalogId,
      eventId,
      posterId: bodyResult.data.posterId,
      userId,
    });
    return NextResponse.json({
      published: true,
      posterId: bodyResult.data.posterId,
      ...result,
    });
  } catch (error) {
    return handleEventPosterRouteError(error, "update");
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const { userId } = await requireEventPosterAccess(catalogId, eventId, "publish");
    const result = await unpublishEventPoster({ catalogId, eventId, userId });
    return NextResponse.json({ published: false, ...result });
  } catch (error) {
    return handleEventPosterRouteError(error, "update");
  }
}
