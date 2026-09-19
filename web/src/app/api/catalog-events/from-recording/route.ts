import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { conflict, badRequest, handlePrismaError, notFound } from "@/lib/api";
import { validateRequestBody } from "@/lib/api/validation";
import { CreateCatalogEventFromRecordingSchema } from "@/lib/catalog-events/validation";
import { deriveEventTitle } from "@/lib/catalog-events/utils";

export const dynamic = "force-dynamic";

type CreateFromRecordingResult =
  | { kind: "created"; eventId: number; title: string; sessionIndex: number }
  | { kind: "recording_not_found" }
  | { kind: "non_actionable" }
  | { kind: "already_assigned"; eventId: number }
  | { kind: "needs_session_confirmation"; eventId: number; nextSessionIndex: number }
  | { kind: "missing_metadata" };

export async function POST(request: NextRequest) {
  try {
    const bodyResult = await validateRequestBody(request, CreateCatalogEventFromRecordingSchema);
    if (!bodyResult.success) return bodyResult.response;
    const body = bodyResult.data;

    const { userId } = await requireCatalogEventsAccess(
      body.workflowGroupId,
      "create_from_recording"
    );

    try {
      const result = await prisma.$transaction<CreateFromRecordingResult>(async (tx) => {
        const [entry, metadata, existingAssignment] = await Promise.all([
          tx.catalogEntry.findFirst({
            where: {
              workflowGroupId: body.workflowGroupId,
              audioHash: body.audioHash,
            },
            select: {
              audioHash: true,
              isActionable: true,
            },
          }),
          tx.audioMetadata.findFirst({
            where: {
              workflowGroupId: body.workflowGroupId,
              audioHash: body.audioHash,
            },
            select: {
              dateYear: true,
              dateMonth: true,
              dateDay: true,
              location: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          }),
          tx.catalogEventRecording.findUnique({
            where: {
              workflowGroupId_audioHash: {
                workflowGroupId: body.workflowGroupId,
                audioHash: body.audioHash,
              },
            },
            select: {
              eventId: true,
            },
          }),
        ]);

        if (!entry) {
          return { kind: "recording_not_found" };
        }
        if (!entry.isActionable) {
          return { kind: "non_actionable" };
        }
        if (existingAssignment) {
          return { kind: "already_assigned", eventId: existingAssignment.eventId };
        }
        if (!metadata?.location || metadata.dateYear == null) {
          return { kind: "missing_metadata" };
        }

        // A second event at one place and date is legitimate here -- two
        // recordings from one venue on one day are usually two discussions.
        // It is still worth confirming, because the catalog list shows only
        // date and location, so a stray one is invisible once created.
        const existing =
          body.sessionIndex === undefined
            ? await tx.catalogEvent.findFirst({
                where: {
                  workflowGroupId: body.workflowGroupId,
                  locationId: metadata.location.id,
                  dateYear: metadata.dateYear,
                  dateMonth: metadata.dateMonth ?? null,
                  dateDay: metadata.dateDay ?? null,
                },
                select: { id: true, sessionIndex: true },
                orderBy: { sessionIndex: "desc" },
              })
            : null;

        if (existing) {
          return {
            kind: "needs_session_confirmation",
            eventId: existing.id,
            nextSessionIndex: existing.sessionIndex + 1,
          };
        }

        const sessionIndex = body.sessionIndex ?? 1;

        const title = deriveEventTitle(
          metadata.location.name,
          metadata.dateYear,
          metadata.dateMonth ?? null,
          metadata.dateDay ?? null,
          sessionIndex
        );

        const createdEvent = await tx.catalogEvent.create({
          data: {
            workflowGroupId: body.workflowGroupId,
            title,
            locationId: metadata.location.id,
            dateYear: metadata.dateYear,
            dateMonth: metadata.dateMonth ?? null,
            dateDay: metadata.dateDay ?? null,
            sessionIndex,
            released: false,
            createdById: userId,
            updatedById: userId,
          },
          select: {
            id: true,
            title: true,
          },
        });

        await tx.catalogEventRecording.create({
          data: {
            eventId: createdEvent.id,
            workflowGroupId: body.workflowGroupId,
            audioHash: body.audioHash,
            isPrimary: true,
          },
        });

        return {
          kind: "created",
          eventId: createdEvent.id,
          title: createdEvent.title ?? title,
          sessionIndex,
        };
      });

      if (result.kind === "recording_not_found") {
        return notFound("catalog recording");
      }
      if (result.kind === "non_actionable") {
        return badRequest("Recording is not actionable");
      }
      if (result.kind === "already_assigned") {
        return conflict(`Recording is already assigned to event ${result.eventId}`);
      }
      if (result.kind === "needs_session_confirmation") {
        return conflict(
          `Event ${result.eventId} already covers this recording's location and date. ` +
            `Attach the recording to it, or resend with sessionIndex ` +
            `${result.nextSessionIndex} to record a separate session.`,
          { eventId: result.eventId, nextSessionIndex: result.nextSessionIndex }
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
