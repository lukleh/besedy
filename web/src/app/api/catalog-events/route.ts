import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { handlePrismaError, badRequest, conflict, notFound } from "@/lib/api";
import { validateRequestBody } from "@/lib/api/validation";
import { getPosterStatus, type PosterStatus } from "@/lib/event-posters";
import { readEventSources } from "@/lib/event-sources";
import {
  CatalogEventsGroupQuerySchema,
  CreateCatalogEventSchema,
} from "@/lib/catalog-events/validation";
import {
  deriveEventTitle,
  normalizeOptionalString,
  parseEventSortKey,
  parseDurationHmsToSeconds,
  parsePagination,
  parsePositiveInt,
  parseSortDirection,
} from "@/lib/catalog-events/utils";
import {
  selectEventPlaybackProgress,
  summarizePlaybackProgress,
} from "@/lib/playback-progress";
import { getPublishedVisibleEventIds } from "@/lib/catalog-events/visibility";
import { requiresListenerEventVisibilityScope } from "@/lib/policy/event";

export const dynamic = "force-dynamic";

const EMPTY_POSTER_STATUS: PosterStatus = { portrait: false, landscape: false };

async function loadEventAssetSummary(
  workflowGroupId: string,
  eventId: number
): Promise<{ posterStatus: PosterStatus; sourceCount: number }> {
  try {
    const [posterStatus, sources] = await Promise.all([
      getPosterStatus(workflowGroupId, eventId),
      readEventSources(workflowGroupId, eventId),
    ]);
    return {
      posterStatus,
      sourceCount: sources.length,
    };
  } catch (error) {
    console.warn(
      `Failed to load event asset summary for ${workflowGroupId}/${eventId}:`,
      error
    );
    return {
      posterStatus: EMPTY_POSTER_STATUS,
      sourceCount: 0,
    };
  }
}

function parseReleasedParam(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseListOrderBy(
  sortKey:
    | "title"
    | "date"
    | "sortOrder"
    | "recordingCount"
    | "location"
    | "released",
  sortDir: "asc" | "desc"
): Prisma.CatalogEventOrderByWithRelationInput[] {
  if (sortKey === "title") {
    return [{ title: sortDir }, { id: "asc" }];
  }
  if (sortKey === "sortOrder") {
    return [{ sortOrder: sortDir }, { id: "asc" }];
  }
  if (sortKey === "recordingCount") {
    return [{ recordings: { _count: sortDir } }, { id: "asc" }];
  }
  if (sortKey === "location") {
    return [{ location: { name: sortDir } }, { id: "asc" }];
  }
  if (sortKey === "released") {
    return [{ released: sortDir }, { dateYear: "desc" }, { dateMonth: "desc" }, { dateDay: "desc" }, { id: "asc" }];
  }

  return [
    { dateYear: sortDir },
    { dateMonth: sortDir },
    { dateDay: sortDir },
    { sessionIndex: sortDir },
    { id: "asc" },
  ];
}

/**
 * GET /api/catalog-events?group=:id
 * Event listing for users with events view access.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const groupResult = CatalogEventsGroupQuerySchema.safeParse({
      group: searchParams.get("group"),
    });
    if (!groupResult.success) {
      return badRequest("Missing or invalid group query parameter");
    }
    const workflowGroupId = groupResult.data.group;

    const group = await prisma.workflowGroup.findFirst({
      where: { id: workflowGroupId, isActive: true },
      select: { id: true },
    });
    if (!group) {
      return notFound("catalog");
    }
    const { accessLevel, userId } = await requireCatalogEventsAccess(workflowGroupId, "view");
    const publishedVisibleEventIds =
      requiresListenerEventVisibilityScope(accessLevel)
        ? await getPublishedVisibleEventIds(prisma, workflowGroupId)
        : null;
    const visibilityWhere =
      publishedVisibleEventIds === null
        ? {}
        : { id: { in: publishedVisibleEventIds.length > 0 ? publishedVisibleEventIds : [-1] } };

    const released = parseReleasedParam(searchParams.get("released"));
    const locationId = parsePositiveInt(searchParams.get("location"));
    const dateYear = parsePositiveInt(searchParams.get("dateYear"));
    const search = normalizeOptionalString(searchParams.get("search"));
    const sequenceOnly = searchParams.get("sequence") === "true";
    const sequenceEventId = parsePositiveInt(searchParams.get("current"));
    const sortKey = parseEventSortKey(searchParams.get("sort"));
    const sortDir = parseSortDirection(searchParams.get("dir"));
    const pagination = parsePagination(searchParams);

    const where: Prisma.CatalogEventWhereInput = {
      workflowGroupId,
      ...visibilityWhere,
      ...(released !== null ? { released } : {}),
      ...(locationId !== null ? { locationId } : {}),
      ...(dateYear !== null ? { dateYear } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { location: { name: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    if (sequenceOnly) {
      if (sequenceEventId === null) {
        return badRequest("Missing or invalid current event id");
      }

      // Keep the response bounded: only IDs are needed to locate the current
      // event, then details are loaded for its two neighbors at most.
      const orderedIds = await prisma.catalogEvent.findMany({
        where,
        orderBy: parseListOrderBy(sortKey, sortDir),
        select: { id: true },
      });
      const index = orderedIds.findIndex((event) => event.id === sequenceEventId);
      if (index < 0) {
        return NextResponse.json({
          previous: null,
          next: null,
          position: null,
          total: orderedIds.length,
        });
      }

      const previousId = index > 0 ? orderedIds[index - 1].id : null;
      const nextId =
        index < orderedIds.length - 1 ? orderedIds[index + 1].id : null;
      const neighborIds = [previousId, nextId].filter(
        (id): id is number => id !== null
      );
      const neighbors =
        neighborIds.length > 0
          ? await prisma.catalogEvent.findMany({
              where: { AND: [where, { id: { in: neighborIds } }] },
              select: {
                id: true,
                dateYear: true,
                dateMonth: true,
                dateDay: true,
                location: { select: { id: true, name: true } },
              },
            })
          : [];
      const neighborById = new Map(neighbors.map((event) => [event.id, event]));

      return NextResponse.json({
        previous: previousId === null ? null : neighborById.get(previousId) ?? null,
        next: nextId === null ? null : neighborById.get(nextId) ?? null,
        position: index + 1,
        total: orderedIds.length,
      });
    }

    const isFiltered =
      released !== null ||
      locationId !== null ||
      dateYear !== null ||
      Boolean(search);

    const [total, totalAllMaybe, events, yearRows, locationRows] = await Promise.all([
      prisma.catalogEvent.count({ where }),
      isFiltered
        ? prisma.catalogEvent.count({ where: { workflowGroupId, ...visibilityWhere } })
        : Promise.resolve<number | null>(null),
      prisma.catalogEvent.findMany({
        where,
        orderBy: parseListOrderBy(sortKey, sortDir),
        skip: pagination.skip,
        take: pagination.take,
        include: {
          location: { select: { id: true, name: true } },
          recordings: {
            select: { audioHash: true, isPrimary: true },
            orderBy: [{ sortOrder: "asc" }, { audioHash: "asc" }],
          },
          _count: { select: { recordings: true } },
        },
      }),
      prisma.catalogEvent.findMany({
        where: { workflowGroupId, ...visibilityWhere },
        distinct: ["dateYear"],
        select: { dateYear: true },
        orderBy: { dateYear: "desc" },
      }),
      prisma.location.findMany({
        where: {
          catalogEvents: {
            some: { workflowGroupId, ...visibilityWhere },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const totalAll = totalAllMaybe ?? total;

    const primaryHashes = Array.from(
      new Set(
        events
          .map(
            (event) =>
              event.recordings.find((recording) => recording.isPrimary)
                ?.audioHash ?? event.recordings[0]?.audioHash
          )
          .filter((hash): hash is string => typeof hash === "string")
      )
    );
    const eventHashes = Array.from(
      new Set(events.flatMap((event) => event.recordings.map((recording) => recording.audioHash)))
    );

    const [catalogRows, metadataRows, playbackRows] = await Promise.all([
      eventHashes.length > 0
        ? prisma.catalogEntry.findMany({
            where: { workflowGroupId, audioHash: { in: eventHashes } },
            select: { audioHash: true, sourceTitle: true, durationHms: true },
          })
        : Promise.resolve([]),
      primaryHashes.length > 0
        ? prisma.audioMetadata.findMany({
            where: { workflowGroupId, audioHash: { in: primaryHashes } },
            select: { audioHash: true, title: true },
          })
        : Promise.resolve([]),
      eventHashes.length > 0
        ? prisma.recordingPlaybackProgress.findMany({
            where: { userId, audioHash: { in: eventHashes } },
            select: {
              audioHash: true,
              positionSec: true,
              durationSec: true,
              completedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const sourceTitleByHash = new Map(catalogRows.map((row) => [row.audioHash, row.sourceTitle]));
    const durationByHash = new Map(
      catalogRows.map((row) => [row.audioHash, parseDurationHmsToSeconds(row.durationHms)])
    );
    const curatedTitleByHash = new Map(metadataRows.map((row) => [row.audioHash, row.title]));
    const playbackByHash = new Map(playbackRows.map((row) => [row.audioHash, row]));
    const eventAssetPairs = await Promise.all(
      events.map(async (event) => [
        event.id,
        await loadEventAssetSummary(workflowGroupId, event.id),
      ] as const)
    );
    const eventAssetsById = new Map(eventAssetPairs);

    const serialized = events.map((event) => {
      const primaryAudioHash =
        event.recordings.find((recording) => recording.isPrimary)?.audioHash ??
        event.recordings[0]?.audioHash ??
        null;
      const primaryTitle =
        primaryAudioHash === null
          ? null
          : curatedTitleByHash.get(primaryAudioHash) ??
            sourceTitleByHash.get(primaryAudioHash) ??
            primaryAudioHash;
      const eventAssets = eventAssetsById.get(event.id) ?? {
        posterStatus: EMPTY_POSTER_STATUS,
        sourceCount: 0,
      };
      const playback = selectEventPlaybackProgress(
        event.recordings.map((recording) =>
          summarizePlaybackProgress(
            playbackByHash.get(recording.audioHash),
            durationByHash.get(recording.audioHash)
          )
        )
      );

      return {
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
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        recordingCount: event._count.recordings,
        sourceCount: eventAssets.sourceCount,
        posterStatus: eventAssets.posterStatus,
        primaryAudioHash,
        primaryTitle,
        playback,
      };
    });

    const totalPages =
      pagination.limit === 0 ? 1 : Math.max(1, Math.ceil(total / pagination.limit));

    return NextResponse.json({
      events: serialized,
      filterOptions: {
        years: yearRows.map((row) => row.dateYear),
        locations: locationRows,
      },
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalAll,
        totalPages,
      },
    });
  } catch (error) {
    return handlePrismaError(error, "catalog event", "fetch");
  }
}

/**
 * POST /api/catalog-events
 * Event creation for admins.
 */
export async function POST(request: NextRequest) {
  try {
    const bodyResult = await validateRequestBody(request, CreateCatalogEventSchema);
    if (!bodyResult.success) return bodyResult.response;
    const body = bodyResult.data;

    const [group, location] = await Promise.all([
      prisma.workflowGroup.findFirst({
        where: { id: body.workflowGroupId, isActive: true },
        select: { id: true },
      }),
      prisma.location.findUnique({
        where: { id: body.locationId },
        select: { id: true, name: true },
      }),
    ]);

    if (!group) {
      return notFound("catalog");
    }
    if (!location) {
      return notFound("location");
    }
    const { userId } = await requireCatalogEventsAccess(body.workflowGroupId, "edit");

    const sessionIndex =
      body.sessionIndex ??
      ((await prisma.catalogEvent.findFirst({
        where: {
          workflowGroupId: body.workflowGroupId,
          locationId: body.locationId,
          dateYear: body.dateYear,
          dateMonth: body.dateMonth ?? null,
          dateDay: body.dateDay ?? null,
        },
        select: { sessionIndex: true },
        orderBy: { sessionIndex: "desc" },
      }))?.sessionIndex ?? 0) + 1;

    const title =
      body.title ??
      deriveEventTitle(
        location.name,
        body.dateYear,
        body.dateMonth ?? null,
        body.dateDay ?? null,
        sessionIndex
      );

    try {
      const created = await prisma.catalogEvent.create({
        data: {
          workflowGroupId: body.workflowGroupId,
          title,
          locationId: body.locationId,
          dateYear: body.dateYear,
          dateMonth: body.dateMonth ?? null,
          dateDay: body.dateDay ?? null,
          sessionIndex,
          description: body.description ?? null,
          sortOrder: body.sortOrder ?? 0,
          createdById: userId,
          updatedById: userId,
        },
        include: {
          location: { select: { id: true, name: true } },
          _count: { select: { recordings: true } },
        },
      });

      return NextResponse.json(
        {
          ...created,
          recordingCount: created._count.recordings,
        },
        { status: 201 }
      );
    } catch (error) {
      // COALESCE identity index conflict
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
    return handlePrismaError(error, "catalog event", "create");
  }
}
