import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventPosterAccess } from "@/lib/event-poster-access";
import { handleEventPosterRouteError } from "@/lib/event-poster-route-errors";
import { deleteEventPosterCandidate } from "@/lib/event-poster-service";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  posterId: z.string().uuid(),
});
interface RouteParams {
  params: Promise<{ id: string; eventId: string; posterId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, posterId } = paramsResult.data;
    const { userId } = await requireEventPosterAccess(catalogId, eventId, "manage");
    await deleteEventPosterCandidate({ catalogId, eventId, posterId, userId });
    return NextResponse.json({ deleted: true, posterId });
  } catch (error) {
    return handleEventPosterRouteError(error, "delete");
  }
}
