import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventArtworkAccess } from "@/lib/event-artwork-access";
import { handleEventArtworkRouteError } from "@/lib/event-artwork-route-errors";
import { loadEventArtworkAsset } from "@/lib/event-artwork-service";
import { ARTWORK_VARIANTS } from "@/lib/event-artwork-storage";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VariantSchema = z.enum(ARTWORK_VARIANTS);
const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  artworkId: z.string().uuid(),
});
interface RouteParams {
  params: Promise<{ id: string; eventId: string; artworkId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, artworkId } = paramsResult.data;
    const variant = VariantSchema.safeParse(new URL(request.url).searchParams.get("variant"));
    if (!variant.success) {
      return NextResponse.json({ error: "Invalid artwork variant" }, { status: 400 });
    }
    await requireEventArtworkAccess(catalogId, eventId, "view_candidates");
    const asset = await loadEventArtworkAsset({
      catalogId,
      eventId,
      artworkId,
      variant: variant.data,
      publishedOnly: false,
    });
    if (!asset) {
      return NextResponse.json({ error: "Artwork candidate not found" }, { status: 404 });
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
    return handleEventArtworkRouteError(error, "fetch");
  }
}
