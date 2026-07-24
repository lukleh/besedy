import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { handlePrismaError, notFound } from "@/lib/api";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; eventId: string; audioHash: string }>;
}

type SetPrimaryResult =
  | { kind: "updated"; eventId: number }
  | { kind: "event_not_found" }
  | { kind: "recording_not_found" };

const CatalogScopedRecordingParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
  audioHash: HashSchema,
});

/**
 * POST /api/catalogs/:id/events/:eventId/recordings/:audioHash/set-primary
 * Primary recording swap endpoint.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedRecordingParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId, audioHash } = paramsResult.data;

    await requireCatalogEventsAccess(catalogId, "set_primary_recording");

    const result = await prisma.$transaction<SetPrimaryResult>(async (tx) => {
      // Serialize primary swaps with release checks and other event mutations.
      await tx.$queryRaw`
        SELECT id
        FROM catalog_event
        WHERE id = ${eventId}
          AND workflow_group_id = ${catalogId}
        FOR UPDATE
      `;

      const event = await tx.catalogEvent.findFirst({
        where: { id: eventId, workflowGroupId: catalogId },
        select: { id: true, workflowGroupId: true },
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
        select: { eventId: true },
      });
      if (!assignment || assignment.eventId !== event.id) {
        return { kind: "recording_not_found" };
      }

      await tx.catalogEventRecording.updateMany({
        where: {
          eventId: event.id,
          workflowGroupId: event.workflowGroupId,
          isPrimary: true,
        },
        data: { isPrimary: false },
      });
      await tx.catalogEventRecording.update({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: event.workflowGroupId,
            audioHash,
          },
        },
        data: { isPrimary: true },
      });

      return { kind: "updated", eventId: event.id };
    });

    if (result.kind === "event_not_found") {
      return notFound("catalog event");
    }
    if (result.kind === "recording_not_found") {
      return notFound("catalog event recording");
    }

    return NextResponse.json({ success: true, eventId: result.eventId, audioHash });
  } catch (error) {
    return handlePrismaError(error, "catalog event recording", "update");
  }
}
