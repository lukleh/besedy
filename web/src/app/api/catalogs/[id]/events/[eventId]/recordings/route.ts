import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { publishRecordingHashes } from "@/lib/catalog-events/publication";
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

type AttachErrorReason =
  | "missing_in_catalog"
  | "non_actionable"
  | "already_attached"
  | "assigned_to_other_event";

type AttachResult =
  | {
      kind: "success";
      attachedAudioHashes: string[];
      errors: Array<{ audioHash: string; reason: AttachErrorReason }>;
    }
  | {
      kind: "bad_request";
      message: string;
      errors: Array<{ audioHash: string; reason: AttachErrorReason }>;
    }
  | { kind: "event_not_found" };

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

    const result = await prisma.$transaction<AttachResult>(async (tx) => {
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

      const [catalogRows, existingAssignments] = await Promise.all([
        tx.catalogEntry.findMany({
          where: {
            workflowGroupId: event.workflowGroupId,
            audioHash: { in: hashes },
          },
          select: { audioHash: true, isActionable: true },
        }),
        tx.catalogEventRecording.findMany({
          where: {
            workflowGroupId: event.workflowGroupId,
            audioHash: { in: hashes },
          },
          select: { audioHash: true, eventId: true },
        }),
      ]);

      const catalogByHash = new Map(catalogRows.map((row) => [row.audioHash, row]));
      const assignmentByHash = new Map(
        existingAssignments.map((row) => [row.audioHash, row.eventId])
      );

      const errorByHash = new Map<string, AttachErrorReason>();
      const attachCandidates: string[] = [];

      for (const audioHash of hashes) {
        const catalogRow = catalogByHash.get(audioHash);
        if (!catalogRow) {
          errorByHash.set(audioHash, "missing_in_catalog");
          continue;
        }
        if (!catalogRow.isActionable) {
          errorByHash.set(audioHash, "non_actionable");
          continue;
        }

        const assignedEventId = assignmentByHash.get(audioHash);
        if (assignedEventId === event.id) {
          errorByHash.set(audioHash, "already_attached");
          continue;
        }
        if (assignedEventId !== undefined && assignedEventId !== event.id) {
          errorByHash.set(audioHash, "assigned_to_other_event");
          continue;
        }

        attachCandidates.push(audioHash);
      }

      if (attachCandidates.length > 0) {
        await tx.catalogEventRecording.createMany({
          data: attachCandidates.map((audioHash) => ({
            eventId: event.id,
            workflowGroupId: event.workflowGroupId,
            audioHash,
          })),
          skipDuplicates: true,
        });
      }

      // Re-read current assignments to ensure response reflects true DB state
      // even under concurrent attach operations.
      const postWriteAssignments =
        attachCandidates.length > 0
          ? await tx.catalogEventRecording.findMany({
              where: {
                workflowGroupId: event.workflowGroupId,
                audioHash: { in: attachCandidates },
              },
              select: { audioHash: true, eventId: true },
            })
          : [];

      const postWriteAssignmentByHash = new Map(
        postWriteAssignments.map((row) => [row.audioHash, row.eventId])
      );
      const attachedAudioHashes: string[] = [];

      for (const audioHash of attachCandidates) {
        const assignedEventId = postWriteAssignmentByHash.get(audioHash);
        if (assignedEventId === event.id) {
          attachedAudioHashes.push(audioHash);
          continue;
        }

        // Lost race to another event assignment or row disappeared during concurrent writes.
        errorByHash.set(audioHash, "assigned_to_other_event");
      }

      if (event.released && attachedAudioHashes.length > 0) {
        await publishRecordingHashes(tx, event.workflowGroupId, attachedAudioHashes);
      }

      const errors = hashes.flatMap((audioHash) => {
        const reason = errorByHash.get(audioHash);
        return reason ? [{ audioHash, reason }] : [];
      });

      if (attachedAudioHashes.length === 0 && errors.length > 0) {
        return {
          kind: "bad_request",
          message: "No recordings could be attached",
          errors,
        };
      }

      return {
        kind: "success",
        attachedAudioHashes,
        errors,
      };
    });

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
