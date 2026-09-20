import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventArtworkAccess } from "@/lib/event-artwork-access";
import { handleEventArtworkRouteError } from "@/lib/event-artwork-route-errors";
import { deleteEventArtworkCandidate } from "@/lib/event-artwork-service";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  artworkId: z.string().uuid(),
});
interface RouteParams {
  params: Promise<{ id: string; eventId: string; artworkId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, artworkId } = paramsResult.data;
    const { userId } = await requireEventArtworkAccess(catalogId, eventId, "manage");
    await deleteEventArtworkCandidate({ catalogId, eventId, artworkId, userId });
    return NextResponse.json({ deleted: true, artworkId });
  } catch (error) {
    return handleEventArtworkRouteError(error, "delete");
  }
}
