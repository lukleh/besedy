import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { handlePrismaError, notFound, validateParams } from "@/lib/api";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import {
  parsePagination,
  parsePositiveInt,
  parseSortDirection,
} from "@/lib/catalog-events/utils";

export const dynamic = "force-dynamic";

type UnassignedSortKey = "title" | "date" | "duration" | "artist";

function parseUnassignedSortKey(value: string | null): UnassignedSortKey {
  if (
    value === "title" ||
    value === "date" ||
    value === "duration" ||
    value === "artist"
  ) {
    return value;
  }
  return "date";
}

function toCountNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/events/unassigned
 * List of actionable catalog rows not assigned to any event.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const workflowGroupId = paramsResult.data.id;
    const { searchParams } = new URL(request.url);

    const group = await prisma.workflowGroup.findFirst({
      where: { id: workflowGroupId, isActive: true },
      select: { id: true },
    });
    if (!group) {
      return notFound("catalog");
    }
    await requireCatalogEventsAccess(workflowGroupId, "edit");

    const locationId = parsePositiveInt(searchParams.get("location"));
    const dateYear = parsePositiveInt(searchParams.get("dateYear"));
    const sortKey = parseUnassignedSortKey(searchParams.get("sort"));
    const sortDir = parseSortDirection(searchParams.get("dir"));
    const pagination = parsePagination(searchParams);

    const filters: Prisma.Sql[] = [
      Prisma.sql`ce.workflow_group_id = ${workflowGroupId}`,
      Prisma.sql`ce.is_actionable = true`,
      Prisma.sql`NOT EXISTS (
        SELECT 1
        FROM catalog_event_recording cer
        WHERE cer.workflow_group_id = ce.workflow_group_id
          AND cer.audio_hash = ce.audio_hash
      )`,
    ];

    if (locationId !== null) {
      filters.push(Prisma.sql`am.location_id = ${locationId}`);
    }
    if (dateYear !== null) {
      filters.push(Prisma.sql`am.date_year = ${dateYear}`);
    }
    const whereSql = Prisma.join(filters, " AND ");

    const sortColumnSql =
      sortKey === "title"
        ? Prisma.sql`COALESCE(am.title, ce.source_title, ce.audio_hash)`
        : sortKey === "artist"
          ? Prisma.sql`COALESCE(am.artist, ce.source_artist, '')`
          : sortKey === "duration"
            ? Prisma.sql`ce.duration_hms`
            : Prisma.sql`(am.date_year * 10000 + COALESCE(am.date_month, 0) * 100 + COALESCE(am.date_day, 0))`;
    const sortDirectionSql = sortDir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    const [countRows, entryRows] = await Promise.all([
      prisma.$queryRaw<Array<{ total: number | bigint | string }>>(Prisma.sql`
        SELECT COUNT(*) AS total
        FROM catalog_entry ce
        LEFT JOIN audio_metadata am
          ON am.workflow_group_id = ce.workflow_group_id
         AND am.audio_hash = ce.audio_hash
        WHERE ${whereSql}
      `),
      prisma.$queryRaw<
        Array<{
          audioHash: string;
          dateYear: number | null;
          dateMonth: number | null;
          dateDay: number | null;
          locationId: number | null;
          locationName: string | null;
          recorderName: string | null;
        }>
      >(Prisma.sql`
        SELECT
          ce.audio_hash AS "audioHash",
          am.date_year AS "dateYear",
          am.date_month AS "dateMonth",
          am.date_day AS "dateDay",
          am.location_id AS "locationId",
          l.name AS "locationName",
          r.name AS "recorderName"
        FROM catalog_entry ce
        LEFT JOIN audio_metadata am
          ON am.workflow_group_id = ce.workflow_group_id
         AND am.audio_hash = ce.audio_hash
        LEFT JOIN locations l
          ON l.id = am.location_id
        LEFT JOIN recorders r
          ON r.id = am.recorder_id
        WHERE ${whereSql}
        ORDER BY ${sortColumnSql} ${sortDirectionSql} NULLS LAST, ce.audio_hash ASC
        ${pagination.take !== undefined
          ? Prisma.sql`LIMIT ${pagination.take} OFFSET ${pagination.skip}`
          : Prisma.empty}
      `),
    ]);

    const total = toCountNumber(countRows[0]?.total ?? 0);
    const totalPages =
      pagination.limit === 0 ? 1 : Math.max(1, Math.ceil(total / pagination.limit));

    const entries = entryRows.map((row) => ({
      audioHash: row.audioHash,
      dateYear: row.dateYear,
      dateMonth: row.dateMonth,
      dateDay: row.dateDay,
      locationId: row.locationId,
      locationName: row.locationName,
      recorderName: row.recorderName,
    }));

    return NextResponse.json({
      entries,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    return handlePrismaError(error, "unassigned recordings", "fetch");
  }
}
