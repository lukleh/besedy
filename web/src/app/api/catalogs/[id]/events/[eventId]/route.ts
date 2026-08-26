import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { publishReleasedEventRecordings } from "@/lib/catalog-events/publication";
import { createEventNotifications } from "@/lib/notifications/event-notifications";
import { sendEventPushNotifications } from "@/lib/notifications/push";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { handlePrismaError, badRequest, conflict, forbidden, notFound } from "@/lib/api";
import { IntIdSchema, validateParams, validateRequestBody } from "@/lib/api/validation";
import {
  UpdateCatalogEventSchema,
} from "@/lib/catalog-events/validation";
import {
  getPublishedAccessibleRecordingHashes,
  isPublishedVisibleEvent,
} from "@/lib/catalog-events/visibility";
import { deriveEventTitle } from "@/lib/catalog-events/utils";
import { getPosterInfo } from "@/lib/event-posters";
import {
  canReleaseEvent,
  requiresReleasedEventVisibilityScope,
} from "@/lib/policy/event";
import { requiresReadyRecordingScope } from "@/lib/policy/recording";
import { TimestampIdSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

type PatchEventResult =
  | {
      kind: "updated";
      responseBody: Record<string, unknown>;
      notificationPayload: null | {
        catalogId: string;
        eventId: number;
        eventTitle: string | null;
        recipientUserIds: string[];
      };
    }
  | { kind: "event_not_found" }
  | { kind: "location_not_found" }
  | { kind: "bad_request"; message: string };

const CatalogScopedEventParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});

/**
 * GET /api/catalogs/:id/events/:eventId
 * Event detail with attached recordings.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    const { userId, accessLevel } = await requireCatalogEventsAccess(catalogId, "view");

    if (requiresReleasedEventVisibilityScope(accessLevel)) {
      const isVisible = await isPublishedVisibleEvent(prisma, catalogId, eventId);
      if (!isVisible) {
        return notFound("catalog event");
      }
    }

    const event = await prisma.catalogEvent.findFirst({
      where: { id: eventId, workflowGroupId: catalogId },
      include: {
        location: { select: { id: true, name: true } },
        recordings: {
          select: {
            audioHash: true,
            isPrimary: true,
            sortOrder: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ sortOrder: "asc" }, { audioHash: "asc" }],
        },
      },
    });

    if (!event) {
      return notFound("catalog event");
    }

    const hashes = event.recordings.map((recording) => recording.audioHash);
    const accessibleHashes =
      requiresReadyRecordingScope(accessLevel)
        ? await getPublishedAccessibleRecordingHashes(
            prisma,
            event.workflowGroupId,
            hashes
          )
        : new Set(hashes);
    const visibleHashes = hashes.filter((hash) => accessibleHashes.has(hash));

    if (requiresReadyRecordingScope(accessLevel) && visibleHashes.length === 0) {
      return notFound("catalog event");
    }

    const [catalogRows, metadataRows] = await Promise.all([
      visibleHashes.length > 0
        ? prisma.catalogEntry.findMany({
            where: {
              workflowGroupId: event.workflowGroupId,
              audioHash: { in: visibleHashes },
            },
            select: {
              audioHash: true,
              durationHms: true,
              sourceTitle: true,
              sourceArtist: true,
            },
          })
        : Promise.resolve([]),
      visibleHashes.length > 0
        ? prisma.audioMetadata.findMany({
            where: {
              workflowGroupId: event.workflowGroupId,
              audioHash: { in: visibleHashes },
            },
            select: {
              audioHash: true,
              title: true,
              artist: true,
              verified: true,
              dateYear: true,
              dateMonth: true,
              dateDay: true,
              recorder: {
                select: {
                  id: true,
                  name: true,
                },
              },
              location: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const catalogByHash = new Map(catalogRows.map((row) => [row.audioHash, row]));
    const metadataByHash = new Map(metadataRows.map((row) => [row.audioHash, row]));

    const recordings = event.recordings
      .filter((recording) => accessibleHashes.has(recording.audioHash))
      .map((recording) => {
        const catalog = catalogByHash.get(recording.audioHash);
        const metadata = metadataByHash.get(recording.audioHash);
        return {
          ...recording,
          title: metadata?.title ?? catalog?.sourceTitle ?? recording.audioHash,
          artist: metadata?.artist ?? catalog?.sourceArtist ?? null,
          durationHms: catalog?.durationHms ?? null,
          verified: metadata?.verified ?? false,
          dateYear: metadata?.dateYear ?? event.dateYear,
          dateMonth: metadata?.dateMonth ?? event.dateMonth,
          dateDay: metadata?.dateDay ?? event.dateDay,
          location: metadata?.location ?? event.location,
          recorder: metadata?.recorder ?? null,
        };
      })
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) {
          return a.isPrimary ? -1 : 1;
        }
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        return a.audioHash.localeCompare(b.audioHash);
      });

    const [catalogCapability, posterInfo] = await Promise.all([
      getCatalogCapability(catalogId, userId),
      getPosterInfo(catalogId, eventId),
    ]);
    const canManagePosters = catalogCapability.canManageAccess;
    const canManageSources = catalogCapability.canManageAccess;
    const posterStatus = {
      portrait: posterInfo.portrait.exists,
      landscape: posterInfo.landscape.exists,
    };

    return NextResponse.json({
      id: event.id,
      workflowGroupId: event.workflowGroupId,
      title: event.title,
      locationId: event.locationId,
      location: event.location,
      dateYear: event.dateYear,
      dateMonth: event.dateMonth,
      dateDay: event.dateDay,
      sessionIndex: event.sessionIndex,
      description: event.description,
      released: event.released,
      sortOrder: event.sortOrder,
      createdById: event.createdById,
      updatedById: event.updatedById,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      recordings,
      canManagePosters,
      canManageSources,
      posterStatus,
      posterFiles: posterInfo,
    });
  } catch (error) {
    return handlePrismaError(error, "catalog event", "fetch");
  }
}

/**
 * PATCH /api/catalogs/:id/events/:eventId
 * Event update endpoint.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    const access = await requireCatalogEventsAccess(catalogId, "edit");
    const { userId } = access;

    const bodyResult = await validateRequestBody(request, UpdateCatalogEventSchema);
    if (!bodyResult.success) return bodyResult.response;
    const body = bodyResult.data;

    if (
      body.released !== undefined &&
      access.policyContext !== undefined &&
      !canReleaseEvent(access.policyContext)
    ) {
      return forbidden("Owner or admin access required to change event release state");
    }

    const existingEvent = await prisma.catalogEvent.findFirst({
      where: { id: eventId, workflowGroupId: catalogId },
      select: { id: true },
    });
    if (!existingEvent) {
      return notFound("catalog event");
    }

    try {
      const result = await prisma.$transaction<PatchEventResult>(async (tx) => {
        // Serialize release/detach operations on the same event row.
        await tx.$queryRaw`
          SELECT id
          FROM catalog_event
          WHERE id = ${eventId}
          FOR UPDATE
        `;

        const existing = await tx.catalogEvent.findFirst({
          where: { id: eventId, workflowGroupId: catalogId },
          include: {
            location: { select: { id: true, name: true } },
          },
        });

        if (!existing) {
          return { kind: "event_not_found" };
        }

        const nextLocationId = body.locationId ?? existing.locationId;
        const nextDateYear = body.dateYear ?? existing.dateYear;
        const nextDateMonth =
          body.dateMonth !== undefined ? body.dateMonth : existing.dateMonth;
        const nextDateDay = body.dateDay !== undefined ? body.dateDay : existing.dateDay;
        const nextSessionIndex = body.sessionIndex ?? existing.sessionIndex;

        if (nextDateDay !== null && nextDateDay !== undefined && nextDateMonth == null) {
          return {
            kind: "bad_request",
            message: "dateDay requires dateMonth",
          };
        }

        let locationName = existing.location.name;
        if (nextLocationId !== existing.locationId) {
          const location = await tx.location.findUnique({
            where: { id: nextLocationId },
            select: { id: true, name: true },
          });
          if (!location) {
            return { kind: "location_not_found" };
          }
          locationName = location.name;
        }

        if (body.released === true) {
          const primaryCount = await tx.catalogEventRecording.count({
            where: { eventId, isPrimary: true },
          });
          if (primaryCount !== 1) {
            return {
              kind: "bad_request",
              message: "Event cannot be released without exactly one primary recording",
            };
          }
        }

        const isFirstRelease =
          body.released === true &&
          !existing.released &&
          existing.publishedNotifiedAt == null;

        const updateData: {
          locationId?: number;
          dateYear?: number;
          dateMonth?: number | null;
          dateDay?: number | null;
          sessionIndex?: number;
          title?: string | null;
          description?: string | null;
          released?: boolean;
          publishedNotifiedAt?: Date;
          sortOrder?: number;
          updatedById: string;
        } = {
          updatedById: userId,
        };

        if (body.locationId !== undefined) updateData.locationId = body.locationId;
        if (body.dateYear !== undefined) updateData.dateYear = body.dateYear;
        if (body.dateMonth !== undefined) updateData.dateMonth = body.dateMonth ?? null;
        if (body.dateDay !== undefined) updateData.dateDay = body.dateDay ?? null;
        if (body.sessionIndex !== undefined) updateData.sessionIndex = body.sessionIndex;
        if (body.description !== undefined) updateData.description = body.description ?? null;
        if (body.released !== undefined) updateData.released = body.released;
        if (isFirstRelease) updateData.publishedNotifiedAt = new Date();
        if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

        if (body.title !== undefined) {
          updateData.title =
            body.title ??
            deriveEventTitle(
              locationName,
              nextDateYear,
              nextDateMonth ?? null,
              nextDateDay ?? null,
              nextSessionIndex
            );
        }

        const updated = await tx.catalogEvent.update({
          where: { id: eventId },
          data: updateData,
          include: {
            location: { select: { id: true, name: true } },
            _count: { select: { recordings: true } },
          },
        });

        if (updated.released) {
          await publishReleasedEventRecordings(tx, catalogId, eventId);
        }

        const notificationPayload =
          isFirstRelease
            ? await createEventNotifications(tx, {
                catalogId,
                eventId,
                title: updated.title,
              }).then((result) =>
                result.recipientUserIds.length > 0
                  ? {
                      catalogId,
                      eventId,
                      eventTitle: updated.title,
                      recipientUserIds: result.recipientUserIds,
                    }
                  : null
              )
            : null;

        return {
          kind: "updated",
          responseBody: {
            ...updated,
            recordingCount: updated._count.recordings,
          },
          notificationPayload,
        };
      });

      if (result.kind === "event_not_found") {
        return notFound("catalog event");
      }
      if (result.kind === "location_not_found") {
        return notFound("location");
      }
      if (result.kind === "bad_request") {
        return badRequest(result.message);
      }

      if (result.notificationPayload) {
        await sendEventPushNotifications(result.notificationPayload).catch((error) => {
          console.error("[Notifications] Failed to send event push:", error);
        });
      }

      return NextResponse.json(result.responseBody);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return conflict("Event with this location, date, and session already exists");
      }
      throw error;
    }
  } catch (error) {
    return handlePrismaError(error, "catalog event", "update");
  }
}

/**
 * DELETE /api/catalogs/:id/events/:eventId
 * Event deletion endpoint.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogScopedEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    await requireCatalogEventsAccess(catalogId, "edit");

    const deleted = await prisma.catalogEvent.deleteMany({
      where: { id: eventId, workflowGroupId: catalogId },
    });
    if (deleted.count === 0) {
      return notFound("catalog event");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handlePrismaError(error, "catalog event", "delete");
  }
}
