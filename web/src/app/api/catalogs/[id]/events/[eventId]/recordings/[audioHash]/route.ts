import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { handlePrismaError, badRequest, notFound } from "@/lib/api";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; eventId: string; audioHash: string }>;
}

type DeleteRecordingResult =
  | { kind: "deleted" }
  | { kind: "event_not_found" }
  | { kind: "recording_not_found" }
  | { kind: "bad_request"; message: string };

const CatalogScopedRecordingParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  audioHash: HashSchema,
});

/**
 * DELETE /api/catalogs/:id/events/:eventId/recordings/:audioHash
 * Recording detach endpoint.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedRecordingParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, audioHash } = paramsResult.data;

    await requireCatalogEventsAccess(catalogId, "detach_recording");

    const result = await prisma.$transaction<DeleteRecordingResult>(async (tx) => {
      // Serialize release/detach operations on the same event row.
      await tx.$queryRaw`
        SELECT id
        FROM catalog_event
        WHERE id = ${eventId}
        FOR UPDATE
      `;

      const event = await tx.catalogEvent.findFirst({
        where: { id: eventId, workflowGroupId: catalogId },
        select: { id: true, workflowGroupId: true, released: true },
      });
      if (!event) {
        return { kind: "event_not_found" };
      }

      const assignment = await tx.catalogEventRecording.findUnique({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: event.workflowGroupId,
            audioHash,
          },
        },
        select: {
          eventId: true,
          isPrimary: true,
        },
      });

      if (!assignment || assignment.eventId !== event.id) {
        return { kind: "recording_not_found" };
      }

      if (event.released && assignment.isPrimary) {
        return {
          kind: "bad_request",
          message:
            "Cannot detach the primary recording from a released event; set another primary or unrelease first",
        };
      }

      await tx.catalogEventRecording.delete({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: event.workflowGroupId,
            audioHash,
          },
        },
      });
      return { kind: "deleted" };
    });

    if (result.kind === "event_not_found") {
      return notFound("catalog event");
    }
    if (result.kind === "recording_not_found") {
      return notFound("catalog event recording");
    }
    if (result.kind === "bad_request") {
      return badRequest(result.message);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "catalog event recording", "delete");
  }
}
