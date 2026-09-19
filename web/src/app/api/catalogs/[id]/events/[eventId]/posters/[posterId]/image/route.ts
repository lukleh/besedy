import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventPosterAccess } from "@/lib/event-poster-access";
import { handleEventPosterRouteError } from "@/lib/event-poster-route-errors";
import { loadEventPosterAsset } from "@/lib/event-poster-service";
import { POSTER_VARIANTS } from "@/lib/event-poster-storage";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VariantSchema = z.enum(POSTER_VARIANTS);
const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  posterId: z.string().uuid(),
});
interface RouteParams {
  params: Promise<{ id: string; eventId: string; posterId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, posterId } = paramsResult.data;
    const variant = VariantSchema.safeParse(new URL(request.url).searchParams.get("variant"));
    if (!variant.success) {
      return NextResponse.json({ error: "Invalid poster variant" }, { status: 400 });
    }
    await requireEventPosterAccess(catalogId, eventId, "view_candidates");
    const asset = await loadEventPosterAsset({
      catalogId,
      eventId,
      posterId,
      variant: variant.data,
      publishedOnly: false,
    });
    if (!asset) {
      return NextResponse.json({ error: "Poster candidate not found" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes.length),
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${asset.sha256}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleEventPosterRouteError(error, "fetch");
  }
}
