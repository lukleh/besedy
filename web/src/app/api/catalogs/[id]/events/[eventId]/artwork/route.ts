import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { isPublishedVisibleEvent } from "@/lib/catalog-events/visibility";
import { handleEventArtworkRouteError } from "@/lib/event-artwork-route-errors";
import { loadEventArtworkAsset } from "@/lib/event-artwork-service";
import { ARTWORK_VARIANTS } from "@/lib/event-artwork-storage";
import { requiresReleasedEventVisibilityScope } from "@/lib/policy/event";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ArtworkVariantSchema = z.enum(ARTWORK_VARIANTS);
const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});

interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

/** Return only the event's currently published artwork. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const variant = ArtworkVariantSchema.safeParse(new URL(request.url).searchParams.get("variant"));
    if (!variant.success) {
      return NextResponse.json({ error: "Invalid artwork variant" }, { status: 400 });
    }

    const { catalogGrant } = await requireCatalogEventsAccess(catalogId, "view");

    if (requiresReleasedEventVisibilityScope(catalogGrant)) {
      const isVisible = await isPublishedVisibleEvent(prisma, catalogId, eventId);
      if (!isVisible) {
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
    }

    const asset = await loadEventArtworkAsset({
      catalogId,
      eventId,
      variant: variant.data,
      publishedOnly: true,
    });
    if (!asset) {
      return NextResponse.json({ error: "Published artwork not found" }, { status: 404 });
    }

    const etag = `"${asset.sha256}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      });
    }

    return new NextResponse(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes.length),
        "Cache-Control": "private, no-cache",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleEventArtworkRouteError(error, "fetch");
  }
}
