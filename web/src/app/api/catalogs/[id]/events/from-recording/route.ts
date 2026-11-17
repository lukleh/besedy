import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { conflict, badRequest, handlePrismaError, notFound, validateParams } from "@/lib/api";
import { validateRequestBody } from "@/lib/api/validation";
import { CreateCatalogEventFromRecordingSchema } from "@/lib/catalog-events/validation";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { createEventFromRecording } from "@/lib/catalog-events/create-from-recording";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** POST /api/catalogs/:id/events/from-recording - Create an event from one recording. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const workflowGroupId = paramsResult.data.id;
    const bodyResult = await validateRequestBody(request, CreateCatalogEventFromRecordingSchema);
    if (!bodyResult.success) return bodyResult.response;
    const body = bodyResult.data;

    const { userId } = await requireCatalogEventsAccess(
      workflowGroupId,
      "create_from_recording"
    );

    try {
      const result = await prisma.$transaction((tx) =>
        createEventFromRecording(tx, {
          workflowGroupId,
          audioHash: body.audioHash,
          userId,
          intent: body.intent,
        })
      );

      if (result.kind === "recording_not_found") {
        return notFound("catalog recording");
      }
      if (result.kind === "non_actionable") {
        return badRequest("Recording is not actionable");
      }
      if (result.kind === "already_assigned") {
        return conflict(`Recording is already assigned to event ${result.eventId}`);
      }
      if (result.kind === "needs_destination_decision") {
        return conflict(
          "One or more events already cover this recording's location and date. " +
            "Attach it to the matching discussion or confirm that it is a distinct event.",
          result.details
        );
      }
      if (result.kind === "missing_metadata") {
        return badRequest("Recording requires location and year metadata before creating an event");
      }

      return NextResponse.json(
        {
          eventId: result.eventId,
          audioHash: body.audioHash,
          title: result.title,
          sessionIndex: result.sessionIndex,
        },
        { status: 201 }
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return conflict(
          "Matching event session already exists or the recording was assigned during creation"
        );
      }
      throw error;
    }
  } catch (error) {
    return handlePrismaError(error, "catalog event", "create");
  }
}
