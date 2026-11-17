import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { attachRecordingsToEvent } from "@/lib/catalog-events/attach-recordings";
import { handlePrismaError, badRequest, notFound } from "@/lib/api";
import { IntIdSchema, validateParams, validateRequestBody } from "@/lib/api/validation";
import {
  AttachRecordingsSchema,
} from "@/lib/catalog-events/validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

const CatalogScopedEventParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});

/**
 * POST /api/catalogs/:id/events/:eventId/recordings
 * Recording attachment endpoint.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    await requireCatalogEventsAccess(catalogId, "attach_recording");

    const bodyResult = await validateRequestBody(request, AttachRecordingsSchema);
    if (!bodyResult.success) return bodyResult.response;

    const hashes = Array.from(new Set(bodyResult.data.audioHashes));
    if (hashes.length === 0) {
      return badRequest("No audio hashes provided");
    }

    const result = await prisma.$transaction((tx) =>
      attachRecordingsToEvent(tx, { catalogId, eventId, audioHashes: hashes })
    );

    if (result.kind === "event_not_found") {
      return notFound("catalog event");
    }
    if (result.kind === "bad_request") {
      return badRequest(result.message, { errors: result.errors });
    }

    return NextResponse.json({
      attachedCount: result.attachedAudioHashes.length,
      attachedAudioHashes: result.attachedAudioHashes,
      errors: result.errors,
    });
  } catch (error) {
    return handlePrismaError(error, "catalog event recording", "create");
  }
}
