import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { requireEventPosterAccess } from "@/lib/event-poster-access";
import { handleEventPosterRouteError } from "@/lib/event-poster-route-errors";
import { createEventPosterCandidate, listEventPosterCandidates } from "@/lib/event-poster-service";
import { MAX_POSTER_UPLOAD_BYTES } from "@/lib/event-poster-storage";
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
    await requireEventPosterAccess(catalogId, eventId, "view_candidates");
    const candidates = await listEventPosterCandidates(catalogId, eventId);
    return NextResponse.json({ candidates });
  } catch (error) {
    return handleEventPosterRouteError(error, "fetch");
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_POSTER_UPLOAD_BYTES * 2 + 1024 * 1024) {
      return NextResponse.json({ error: "Poster upload is too large", code: "UPLOAD_TOO_LARGE" }, { status: 413 });
    }

    const paramsResult = validateParams(await params, RouteParamsSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const { userId } = await requireEventPosterAccess(catalogId, eventId, "manage");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "Unable to read poster upload", code: "UPLOAD_PARSE_FAILED" }, { status: 400 });
    }
    const square = form.get("square");
    const landscape = form.get("landscape");
    if (!isFile(square) || !isFile(landscape)) {
      return NextResponse.json({ error: "Both square and landscape poster files are required" }, { status: 400 });
    }
    if (square.size > MAX_POSTER_UPLOAD_BYTES || landscape.size > MAX_POSTER_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Poster upload is too large", code: "UPLOAD_TOO_LARGE" }, { status: 413 });
    }
    const labelValue = form.get("label");
    const label = typeof labelValue === "string" ? labelValue : null;

    const candidate = await createEventPosterCandidate({
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
    return handleEventPosterRouteError(error, "create");
  }
}
