import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventArtworkAccess } from "@/lib/event-artwork-access";
import { handleEventArtworkRouteError } from "@/lib/event-artwork-route-errors";
import { createEventArtworkCandidate, listEventArtworkCandidates } from "@/lib/event-artwork-service";
import { MAX_ARTWORK_UPLOAD_BYTES } from "@/lib/event-artwork-storage";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RouteParamsSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});
interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

function isFile(value: FormDataEntryValue | null): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value && "name" in value && "size" in value;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    await requireEventArtworkAccess(catalogId, eventId, "view_candidates");
    const candidates = await listEventArtworkCandidates(catalogId, eventId);
    return NextResponse.json({ candidates });
  } catch (error) {
    return handleEventArtworkRouteError(error, "fetch");
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader === null) {
      return NextResponse.json(
        {
          error: "Artwork uploads require a Content-Length header",
          code: "CONTENT_LENGTH_REQUIRED",
        },
        { status: 411 }
      );
    }
    const contentLength = Number(contentLengthHeader);
    if (!/^\d+$/.test(contentLengthHeader) || !Number.isSafeInteger(contentLength) || contentLength < 0) {
      return NextResponse.json(
        {
          error: "Artwork upload has an invalid Content-Length header",
          code: "INVALID_CONTENT_LENGTH",
        },
        { status: 400 }
      );
    }
    if (contentLength > MAX_ARTWORK_UPLOAD_BYTES * 2 + 1024 * 1024) {
      return NextResponse.json({ error: "Artwork upload is too large", code: "UPLOAD_TOO_LARGE" }, { status: 413 });
    }

    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const { userId } = await requireEventArtworkAccess(catalogId, eventId, "manage");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "Unable to read artwork upload", code: "UPLOAD_PARSE_FAILED" }, { status: 400 });
    }
    const square = form.get("square");
    const landscape = form.get("landscape");
    if (!isFile(square) || !isFile(landscape)) {
      return NextResponse.json({ error: "Both square and landscape artwork files are required" }, { status: 400 });
    }
    if (square.size > MAX_ARTWORK_UPLOAD_BYTES || landscape.size > MAX_ARTWORK_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Artwork upload is too large", code: "UPLOAD_TOO_LARGE" }, { status: 413 });
    }
    const labelValue = form.get("label");
    const label = typeof labelValue === "string" ? labelValue : null;

    const candidate = await createEventArtworkCandidate({
      catalogId,
      eventId,
      userId,
      label,
      square: {
        bytes: Buffer.from(await square.arrayBuffer()),
        originalName: square.name,
      },
      landscape: {
        bytes: Buffer.from(await landscape.arrayBuffer()),
        originalName: landscape.name,
      },
    });
    return NextResponse.json({ candidate }, { status: 201 });
  } catch (error) {
    return handleEventArtworkRouteError(error, "create");
  }
}
